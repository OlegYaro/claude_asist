import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTuiReady } from './tui-ready.ts'

test('готов по нижней подсказке', () => {
  assert.equal(isTuiReady('?forshortcuts'), true)
  assert.equal(isTuiReady('⏵⏵acceptedits(shift+tabtocycle)'), true)
})

test('готов по рамке поля ввода, когда подсказку закрыла статус-строка', () => {
  assert.equal(isTuiReady('╭──────╮│>│╰──────╯'), true)
  assert.equal(isTuiReady('│❯Trysomething│'), true)
})

test('не готов в диалоге доверия и на пустом экране', () => {
  assert.equal(isTuiReady(''), false)
  assert.equal(isTuiReady('Doyoutrustthefilesinthisfolder?❯1.Yes,Itrustthisfolder2.No,exit'), false)
  assert.equal(isTuiReady('╭──╮│❯1.Yes,Itrustthisfolder│2.No,exit│╰──╯'), false)
  assert.equal(isTuiReady('│❯1.No,exit│'), false)
  assert.equal(isTuiReady('│❯1.UsethisandallfutureMCPserversinthisproject│2.Usethisserver│3.Continuewithoutusingthisserver│'), false)
})
