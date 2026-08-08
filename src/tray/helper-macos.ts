/**
 * macOS menu-bar helper.
 *
 * The Swift source is embedded here and compiled on first use into the runtime
 * directory, keyed by a hash of the source so an upgrade rebuilds automatically.
 * This keeps the npm package free of platform binaries and of any native build
 * step at install time — the cost is that a menu-bar icon needs Xcode Command
 * Line Tools, which is checked for and reported clearly.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CliError } from '../cli/errors'

const execFileAsync = promisify(execFile)
const BUILD_TIMEOUT_MS = 120_000

const SWIFT_SOURCE = String.raw`import AppKit
import Foundation

// Menu-bar helper for KiroLink. Reads tab-separated status lines on stdin and
// writes command words to stdout; see src/tray/protocol.ts.
final class TrayDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var creditsLine: NSMenuItem!
    private var requestsLine: NSMenuItem!
    private var inputBuffer = Data()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // .accessory keeps the helper out of the Dock and the app switcher.
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "link.circle", accessibilityDescription: "KiroLink")
            image?.isTemplate = true
            button.image = image
            button.toolTip = "KiroLink"
        }

        let menu = NSMenu()
        statusLine = disabledItem("Starting…")
        creditsLine = disabledItem("")
        requestsLine = disabledItem("")
        menu.addItem(statusLine)
        menu.addItem(creditsLine)
        menu.addItem(requestsLine)
        menu.addItem(.separator())
        menu.addItem(actionItem("Open Dashboard", #selector(openDashboard), "d"))
        menu.addItem(actionItem("Copy Base URL", #selector(copyBaseUrl), "c"))
        menu.addItem(.separator())
        menu.addItem(actionItem("Restart Proxy", #selector(restart), "r"))
        menu.addItem(actionItem("Stop Proxy", #selector(stop), "s"))
        menu.addItem(.separator())
        menu.addItem(actionItem("Quit KiroLink", #selector(quit), "q"))
        statusItem.menu = menu

        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                // Parent closed stdin: it is gone, so the helper must not linger.
                DispatchQueue.main.async { NSApp.terminate(nil) }
                return
            }
            DispatchQueue.main.async { self?.consume(data) }
        }
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func emit(_ command: String) {
        print(command)
        fflush(stdout)
    }

    private func consume(_ data: Data) {
        inputBuffer.append(data)
        while let newline = inputBuffer.firstIndex(of: 10) {
            let lineData = inputBuffer.prefix(upTo: newline)
            inputBuffer.removeSubrange(...newline)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            handle(line: line)
        }
    }

    private func handle(line: String) {
        let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        guard let kind = fields.first else { return }

        if kind == "status", fields.count >= 2 {
            applyStatus(json: fields[1])
        } else if kind == "notify", fields.count >= 3 {
            notify(title: fields[1], body: fields[2])
        }
    }

    private func applyStatus(json: String) {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let running = object["running"] as? Bool ?? false
        let baseUrl = object["baseUrl"] as? String ?? ""
        let credits = object["credits"] as? String ?? ""
        let requests = object["requests"] as? Int ?? 0
        let auth = object["auth"] as? String ?? ""

        statusLine.title = running ? "Running · \(baseUrl)" : "Stopped"
        creditsLine.title = credits.isEmpty ? "Credits: unknown" : credits
        requestsLine.title = "Requests: \(requests) · auth \(auth)"
        statusItem.button?.toolTip = running ? "KiroLink · \(baseUrl)" : "KiroLink · stopped"
    }

    private func notify(title: String, body: String) {
        // NSUserNotification is deprecated but needs no bundle identifier or
        // authorization prompt, which UNUserNotificationCenter requires and a
        // compiled-on-the-fly helper cannot satisfy.
        let notification = NSUserNotification()
        notification.title = title
        notification.informativeText = body
        NSUserNotificationCenter.default.deliver(notification)
    }

    @objc private func openDashboard() { emit("dashboard") }
    @objc private func copyBaseUrl() { emit("copy") }
    @objc private func restart() { emit("restart") }
    @objc private func stop() { emit("stop") }
    @objc private func quit() {
        emit("quit")
        // Give the parent a moment to act on "quit" before the helper exits.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = TrayDelegate()
app.delegate = delegate
app.run()
`

/** Compile the helper if needed and return its path. */
export async function buildMacTrayHelper(runtimeDir: string): Promise<string> {
  const sourcePath = join(runtimeDir, 'KiroLinkTray.swift')
  const binaryPath = join(runtimeDir, 'kirolink-tray')
  const stampPath = join(runtimeDir, 'kirolink-tray.sha256')
  const hash = createHash('sha256').update(SWIFT_SOURCE).digest('hex')

  const stamp = await readFile(stampPath, 'utf8').catch(() => '')
  if (stamp.trim() === hash) return binaryPath

  await writeFile(sourcePath, SWIFT_SOURCE, { mode: 0o600 })
  try {
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-O', sourcePath, '-o', binaryPath, '-framework', 'AppKit'], {
      timeout: BUILD_TIMEOUT_MS,
    })
  } catch (error) {
    throw new CliError('Could not build the macOS menu-bar helper', {
      hint: 'Install Xcode Command Line Tools: xcode-select --install',
      cause: error,
    })
  }
  await writeFile(stampPath, `${hash}\n`, { mode: 0o600 })
  return binaryPath
}

/** Whether a Swift compiler is available, without building anything. */
export async function isMacTrayAvailable(): Promise<boolean> {
  try {
    await execFileAsync('/usr/bin/xcrun', ['--find', 'swiftc'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}
