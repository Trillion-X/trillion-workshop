# Text Work Action

`TextWorkAction` is the package UI primitive for one text input and one package-owned action.

It owns only browser-local interaction state. It does not know package names, workflow IDs, storage addresses, or provider details. Package panels provide the labels and the `onStart(text)` handler.
