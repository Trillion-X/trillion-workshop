# browser-saved-items

This package owns reversible organization of a person's explicitly authorized
saved browser items. It reads the browser's saved-item graph, preserves every
item and nested browser-native grouping, writes a complete decision inventory,
backs up the source file, and applies category changes atomically.

The current provider handles Arc's `StorableSidebar.json` Personal space. It
does not read browsing history, cookies, credentials, page content, or other
profiles.

