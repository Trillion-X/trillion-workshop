# native-color-picker/

Shared browser-native color picker chrome.

`NativeColorInput` wraps `<input type="color">` with the product's focus and
surface styling. `NativeColorPickerPanel` composes that input with the same
compact "Save color +" panel first used by the drawing toolbar.

Callers own the color value, labels, persistence, and what "save" means. This
package only renders the local control.
