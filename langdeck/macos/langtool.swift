// langtool.swift — macOS input-source helper for the Lang Cycle Stream Deck plugin (#37).
//
// Uses Text Input Services (Carbon/HIToolbox). These functions are legacy-named but are NOT
// deprecated and remain the supported way to enumerate, read and select keyboard input
// sources on macOS 13/14/15.
//
// Commands (all output is JSON on one line, so the Node side can parse it without a library):
//   langtool list            -> {"ok":true,"sources":[{"id":..,"name":..,"current":bool},..]}
//   langtool current         -> {"ok":true,"id":..,"name":..}
//   langtool select <id>     -> {"ok":true,"id":..}   or {"ok":false,"error":..}
//   langtool watch           -> emits one JSON line per input-source change, forever
//
// `watch` exists because macOS, unlike Windows, publishes a change notification
// (kTISNotifySelectedKeyboardInputSourceChanged). That means the Mac build can be event-driven
// instead of polling, so the key face updates instantly rather than within a poll interval.
//
// NOTE: switching input source via TIS is NOT keystroke synthesis, so it requires no
// Accessibility / Input Monitoring / Automation permission. If macOS ever prompts you for one
// while running this, that is a finding worth reporting — it would mean the assumption is wrong.

import Foundation
import Carbon

// MARK: - property readers

func stringProp(_ src: TISInputSource, _ key: CFString) -> String {
    guard let p = TISGetInputSourceProperty(src, key) else { return "" }
    return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
}

func boolProp(_ src: TISInputSource, _ key: CFString) -> Bool {
    guard let p = TISGetInputSourceProperty(src, key) else { return false }
    return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(p).takeUnretainedValue())
}

// MARK: - source enumeration

/// Enabled, selectable, keyboard-category sources — i.e. the things the user can actually
/// switch between. Without this filter the list also contains palettes, ink and non-selectable
/// entries, which would make a "cycle to next" walk land on something unselectable.
func selectableKeyboardSources() -> [TISInputSource] {
    guard let cf = TISCreateInputSourceList(nil, false) else { return [] }
    guard let all = cf.takeRetainedValue() as? [TISInputSource] else { return [] }
    let keyboardCategory = kTISCategoryKeyboardInputSource as String
    return all.filter { s in
        stringProp(s, kTISPropertyInputSourceCategory) == keyboardCategory
            && boolProp(s, kTISPropertyInputSourceIsSelectCapable)
            && boolProp(s, kTISPropertyInputSourceIsEnabled)
    }
}

func currentSource() -> TISInputSource? {
    guard let cf = TISCopyCurrentKeyboardInputSource() else { return nil }
    return cf.takeRetainedValue()
}

// MARK: - JSON output (hand-rolled; avoids any dependency and keeps output one line)

func jsonEscape(_ s: String) -> String {
    var out = ""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    return out
}

func emit(_ line: String) {
    print(line)
    fflush(stdout)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit("{\"ok\":false,\"error\":\"\(jsonEscape(message))\"}")
    exit(code)
}

func sourceJSON(_ s: TISInputSource, currentID: String?) -> String {
    let id = stringProp(s, kTISPropertyInputSourceID)
    let name = stringProp(s, kTISPropertyLocalizedName)
    let isCurrent = (currentID != nil && currentID == id)
    return "{\"id\":\"\(jsonEscape(id))\",\"name\":\"\(jsonEscape(name))\",\"current\":\(isCurrent)}"
}

// MARK: - commands

func cmdList() {
    let cur = currentSource().map { stringProp($0, kTISPropertyInputSourceID) }
    let sources = selectableKeyboardSources()
    let body = sources.map { sourceJSON($0, currentID: cur) }.joined(separator: ",")
    emit("{\"ok\":true,\"sources\":[\(body)]}")
}

func cmdCurrent() {
    guard let s = currentSource() else { fail("no current keyboard input source") }
    let id = stringProp(s, kTISPropertyInputSourceID)
    let name = stringProp(s, kTISPropertyLocalizedName)
    emit("{\"ok\":true,\"id\":\"\(jsonEscape(id))\",\"name\":\"\(jsonEscape(name))\"}")
}

func cmdSelect(_ wanted: String) {
    guard let match = selectableKeyboardSources().first(where: {
        stringProp($0, kTISPropertyInputSourceID) == wanted
    }) else {
        fail("no enabled, selectable keyboard source with id: \(wanted)")
    }
    let status = TISSelectInputSource(match)
    if status != noErr {
        fail("TISSelectInputSource returned OSStatus \(status)", code: 2)
    }
    emit("{\"ok\":true,\"id\":\"\(jsonEscape(wanted))\"}")
}

/// Event-driven change reporting. This is the macOS advantage over Windows: no polling.
func cmdWatch() {
    let name = Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String)
    DistributedNotificationCenter.default().addObserver(
        forName: name, object: nil, queue: nil
    ) { _ in
        guard let s = currentSource() else { return }
        let id = stringProp(s, kTISPropertyInputSourceID)
        let localized = stringProp(s, kTISPropertyLocalizedName)
        emit("{\"ok\":true,\"event\":\"changed\",\"id\":\"\(jsonEscape(id))\",\"name\":\"\(jsonEscape(localized))\"}")
    }
    emit("{\"ok\":true,\"event\":\"watching\"}")
    CFRunLoopRun()
}

// MARK: - entry

let args = Array(CommandLine.arguments.dropFirst())
guard let verb = args.first else {
    fail("usage: langtool <list|current|select <id>|watch>")
}

switch verb {
case "list":    cmdList()
case "current": cmdCurrent()
case "select":
    guard args.count >= 2 else { fail("select needs an input source id") }
    cmdSelect(args[1])
case "watch":   cmdWatch()
default:        fail("unknown command: \(verb)")
}
