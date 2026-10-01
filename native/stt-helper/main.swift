// Локальное распознавание речи через Speech framework macOS 26.
//
// Работает полностью на устройстве: модель скачивается системой один раз,
// аудио никуда не отправляется, API-ключи не нужны.
//
// Использование:
//   stt-helper transcribe <путь-к-wav> [локаль]   → {"text":"…","engine":"…"}
//   stt-helper probe [локаль]                     → {"available":true,…}
//
// Ответ всегда одна строка JSON в stdout; при ошибке — {"error":"…"} и код выхода 1.
// Такой контракт удобен вызывающей стороне: не надо разбирать человекочитаемый вывод.

import AVFoundation
import Foundation
import Speech

// MARK: - Вывод

enum Out {
    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let line = String(data: data, encoding: .utf8)
        else {
            print(#"{"error":"не удалось сериализовать ответ"}"#)
            return
        }
        print(line)
    }

    static func fail(_ message: String, code: String = "stt-failed") -> Never {
        emit(["error": message, "code": code])
        exit(1)
    }
}

// MARK: - Выбор движка

/// В macOS 26 два модуля распознавания с разным покрытием языков:
///
///  - `SpeechTranscriber`   — качественнее на длинной речи, но всего ~30 локалей
///                            и БЕЗ русского;
///  - `DictationTranscriber` — модель системной диктовки, 54 локали, включая ru-RU.
///
/// Поэтому движок выбирается по локали, а не назначается раз и навсегда:
/// для английского берём SpeechTranscriber, для русского — DictationTranscriber.
@available(macOS 26.0, *)
enum Engine {
    case speech(SpeechTranscriber, Locale)
    case dictation(DictationTranscriber, Locale)

    var module: any SpeechModule {
        switch self {
        case let .speech(m, _): return m
        case let .dictation(m, _): return m
        }
    }

    var locale: Locale {
        switch self {
        case let .speech(_, l): return l
        case let .dictation(_, l): return l
        }
    }

    var name: String {
        switch self {
        case .speech: return "SpeechTranscriber"
        case .dictation: return "DictationTranscriber"
        }
    }

    /// Собирает весь текст, дождавшись закрытия последовательности результатов.
    func collectText() -> Task<String, Error> {
        switch self {
        case let .speech(m, _):
            return Task {
                var pieces: [String] = []
                for try await r in m.results { pieces.append(String(r.text.characters)) }
                return pieces.joined()
            }
        case let .dictation(m, _):
            return Task {
                var pieces: [String] = []
                for try await r in m.results { pieces.append(String(r.text.characters)) }
                return pieces.joined()
            }
        }
    }

    /// Подбирает движок под запрошенную локаль. SpeechTranscriber в приоритете,
    /// DictationTranscriber — как более широкий по языкам запасной вариант.
    ///
    /// Внимание: `supportedLocale(equivalentTo:)` только нормализует локаль и НЕ
    /// проверяет поддержку — для ru-RU он возвращает ru-RU даже у SpeechTranscriber,
    /// в списке которого русского нет. Поэтому принадлежность проверяем явно
    /// по `supportedLocales`, иначе выберется движок, который не умеет этот язык.
    static func select(for identifier: String) async -> Engine? {
        let requested = Locale(identifier: identifier)
        // Если просили с регионом и точного совпадения нет, пробуем голый язык.
        let language = identifier.split(separator: "-").first.map(String.init) ?? identifier
        let candidates =
            language == identifier ? [requested] : [requested, Locale(identifier: language)]

        let speechLocales = Set(await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) })
        for candidate in candidates {
            guard let match = await SpeechTranscriber.supportedLocale(equivalentTo: candidate),
                  speechLocales.contains(match.identifier(.bcp47))
            else { continue }
            return .speech(SpeechTranscriber(locale: match, preset: .transcription), match)
        }

        let dictationLocales = Set(
            await DictationTranscriber.supportedLocales.map { $0.identifier(.bcp47) })
        for candidate in candidates {
            guard let match = await DictationTranscriber.supportedLocale(equivalentTo: candidate),
                  dictationLocales.contains(match.identifier(.bcp47))
            else { continue }
            return .dictation(DictationTranscriber(locale: match, preset: .shortDictation), match)
        }
        return nil
    }
}

/// Догружает языковую модель, если система её ещё не установила. Первый запуск для
/// нового языка может занять заметное время — дальше всё локально и быстро.
@available(macOS 26.0, *)
func ensureModelInstalled(_ engine: Engine) async throws {
    let status = await AssetInventory.status(forModules: [engine.module])
    if status == .installed { return }
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [engine.module]) {
        try await request.downloadAndInstall()
    }
}

// MARK: - Распознавание файла

@available(macOS 26.0, *)
func transcribe(path: String, localeId: String) async {
    guard FileManager.default.fileExists(atPath: path) else {
        Out.fail("Файл не найден: \(path)")
    }
    guard let engine = await Engine.select(for: localeId) else {
        Out.fail("Локаль \(localeId) не поддерживается системой", code: "stt-unavailable")
    }

    do {
        try await ensureModelInstalled(engine)
        // Резервируем локаль, иначе система вправе вытеснить модель ради другой.
        _ = try? await AssetInventory.reserve(locale: engine.locale)

        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))

        // Потребителя результатов запускаем ДО анализатора: `results` — живая
        // AsyncSequence, подписаться на неё нужно раньше, чем пойдут результаты.
        let collector = engine.collectText()

        // finishAfterFile: true — анализатор завершится по концу файла, после чего
        // последовательность результатов закроется и collector вернёт полный текст.
        _ = try await SpeechAnalyzer(
            inputAudioFile: file,
            modules: [engine.module],
            finishAfterFile: true
        )

        let text = try await collector.value
        Out.emit([
            "text": text.trimmingCharacters(in: .whitespacesAndNewlines),
            "locale": engine.locale.identifier(.bcp47),
            "engine": engine.name
        ])
        exit(0)
    } catch {
        Out.fail("Ошибка распознавания: \(error.localizedDescription)")
    }
}

// MARK: - Проверка готовности

@available(macOS 26.0, *)
func probe(localeId: String) async {
    guard let engine = await Engine.select(for: localeId) else {
        let speech = await SpeechTranscriber.supportedLocales
        let dictation = await DictationTranscriber.supportedLocales
        let all = Set((speech + dictation).map { $0.identifier(.bcp47) }).sorted()
        Out.emit([
            "available": false,
            "installed": false,
            "reason": "локаль \(localeId) не поддерживается",
            "supportedLocales": all
        ])
        exit(0)
    }

    let status = await AssetInventory.status(forModules: [engine.module])
    Out.emit([
        "available": true,
        // Не установлена — не ошибка: первое распознавание дотянет модель само.
        "installed": status == .installed,
        "status": String(describing: status),
        "locale": engine.locale.identifier(.bcp47),
        "engine": engine.name
    ])
    exit(0)
}

// MARK: - Точка входа

let args = Array(CommandLine.arguments.dropFirst())
guard #available(macOS 26.0, *) else {
    Out.fail("Требуется macOS 26 или новее", code: "stt-unavailable")
}

switch args.first {
case "transcribe":
    guard args.count >= 2 else {
        Out.fail("Использование: stt-helper transcribe <wav> [локаль]")
    }
    await transcribe(path: args[1], localeId: args.count >= 3 ? args[2] : "ru-RU")

case "probe":
    await probe(localeId: args.count >= 2 ? args[1] : "ru-RU")

default:
    Out.fail("Использование: stt-helper transcribe <wav> [локаль] | probe [локаль]")
}
