// Simulates what a password manager does when it copies a secret: mark the
// pasteboard write with the nspasteboard.org "do not record" type alongside
// the plain string. Used by the `#[ignore]`d integration test in
// `src/clipboard_history.rs` to prove such a write is never captured.
//
//   swiftc -O concealed_write.swift -o /tmp/concealed_write
//   KLAUDIO_CONCEALED_BIN=/tmp/concealed_write \
//     cargo test -- --ignored --nocapture pasteboard
import AppKit

let pb = NSPasteboard.general
let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
pb.declareTypes([.string, concealed], owner: nil)
pb.setString(
    CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "hunter2",
    forType: .string
)
print("wrote concealed clip, changeCount = \(pb.changeCount)")
