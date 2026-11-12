# see-what-this-computer-did

Reads this computer's own event rows (list:computer-events), newest first. The row kind `computer-event` is `merge: crdt`: each row is written once, by one computer, and never changed, so rows from every computer commute and need no writer term.

Owner of the kind: this tool. The app (trillion-apps macos/computer-reader.json, event_rows) writes rows of this kind and must not redeclare it; the test in test/ checks the row type matches.
