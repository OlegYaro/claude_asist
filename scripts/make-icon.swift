// Рисует иконку приложения (1024×1024 PNG) — микрофон на тёплом фоне.
// Использование: swift scripts/make-icon.swift <out.png>
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024.0
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// Фон — скруглённый квадрат по сетке иконок macOS (отступ ~10%).
let inset = 100.0
let bg = NSBezierPath(
    roundedRect: NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset),
    xRadius: 185, yRadius: 185)
NSGradient(
    starting: NSColor(calibratedRed: 0.85, green: 0.47, blue: 0.34, alpha: 1),
    ending: NSColor(calibratedRed: 0.55, green: 0.24, blue: 0.16, alpha: 1))!
    .draw(in: bg, angle: -90)

NSColor(calibratedWhite: 0.98, alpha: 1).setFill()
NSColor(calibratedWhite: 0.98, alpha: 1).setStroke()

// Капсула микрофона.
NSBezierPath(roundedRect: NSRect(x: 412, y: 450, width: 200, height: 330), xRadius: 100, yRadius: 100).fill()

// Дуга держателя.
let arc = NSBezierPath()
arc.lineWidth = 44
arc.lineCapStyle = .round
arc.appendArc(withCenter: NSPoint(x: 512, y: 560), radius: 175, startAngle: 200, endAngle: 340, clockwise: false)
arc.stroke()

// Ножка и основание.
let stem = NSBezierPath()
stem.lineWidth = 44
stem.lineCapStyle = .round
stem.move(to: NSPoint(x: 512, y: 385))
stem.line(to: NSPoint(x: 512, y: 300))
stem.move(to: NSPoint(x: 420, y: 290))
stem.line(to: NSPoint(x: 604, y: 290))
stem.stroke()

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("Иконка: \(out)")
