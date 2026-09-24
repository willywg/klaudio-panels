import AppKit
import WebKit

final class Host: NSObject, NSApplicationDelegate {
    let url: URL
    var window: NSWindow!
    var webView: WKWebView!
    var polls = 0

    init(url: URL) { self.url = url }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1000))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1600, height: 1000),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.webView = webView
        self.window = window
        webView.load(URLRequest(url: url))
        poll()
    }

    func poll() {
        polls += 1
        let title = webView.title ?? ""
        if title.hasPrefix("READY") {
            let pid = webView.value(forKey: "_webProcessIdentifier") ?? "?"
            print("TITLE \(title)")
            print("WEBCONTENT \(pid)")
            fflush(stdout)
            // Stay up until stdin closes so the runner can footprint the
            // still-live WebContent and GPU processes, then quit.
            DispatchQueue.global().async {
                _ = FileHandle.standardInput.readDataToEndOfFile()
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
            return
        }
        if polls > 720 {
            fputs("TIMEOUT\n", stderr)
            exit(2)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.poll() }
    }
}

guard CommandLine.arguments.count > 1, let url = URL(string: CommandLine.arguments[1]) else {
    fputs("usage: swift host.swift <url>\n", stderr)
    exit(1)
}

let app = NSApplication.shared
let host = Host(url: url)
app.setActivationPolicy(.regular)
app.delegate = host
app.run()
