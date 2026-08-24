#!/usr/bin/env node
import puppeteer from 'puppeteer'

const url = process.argv[2] || 'http://127.0.0.1:3201/?v=40.7310-74.0834+12.5+57+106&agg=lot'
const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 800, height: 800 })
await page.goto(url)
console.error(`Opened: ${url}`)
console.error('Adjust the view and resize the window, then press Enter here to capture state...')

process.stdin.setRawMode?.(false)
await new Promise(r => process.stdin.once('data', r))

const state = await page.evaluate(() => ({
  url: window.location.href,
  query: window.location.search,
  width: window.innerWidth,
  height: window.innerHeight,
}))
console.log(JSON.stringify(state, null, 2))
await browser.close()
