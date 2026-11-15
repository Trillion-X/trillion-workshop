# Native host for a published app

The build implementation, icon generator and Swift host now belong to the engine-installed Workshop at `tools/assemble-and-publish-an-app-project/native/`. This repository keeps runtime compatibility entries for the command and JavaScript APIs. Set `TRILLION_WORKSHOP_STATE` to the selected account state; a standalone Keychain-backed build also uses that account’s `TRILLION_ORIGIN`.

`src/app-project.mjs` describes an app's source revision, page routes and capability references without choosing a device. `appProjectFromPublicApp` translates the current public app editor source and its live installation address into that project. At build time the publisher reads `read_public_app_installation` itself and requires the complete project to match the current installation. The account key stays in macOS Keychain and in the publisher process; it is never put in the project file or command line.

The publisher also requires each requested iPhone or Mac output to be marked buildable by the project model.

`scripts/build-native-app.mjs` creates an XcodeGen project and optionally builds an iPhone Simulator app, a Mac app, or both:

```sh
node scripts/build-native-app.mjs --project /absolute/path/app-project.json \
  --bundle-id ai.example.myapp --account-keychain-service my-trillion-account-key \
  --target both --build
```

Generated files live under `~/Library/Developer/Trillion/AppProjectBuilds/`. The script prints the exact folder. `DerivedData/Build/Products/Debug-iphonesimulator/<project-id>.app` is the Simulator build; `DerivedData/Build/Products/Debug/<project-id>.app` is the Mac build. The app still displays the person's chosen name. Xcode signing and distribution use the app owner's own bundle identity and Apple account; this script does not publish to an App Store.

The iPhone and Mac targets use an icon explicitly linked by the current installed app's home page or its linked manifest, if that image is one of the installation's own published files. Published blob bytes are checked against the installation's BLAKE3 reference. When the app declares no usable icon, the builder draws a deterministic high-contrast initial from its display name. This fallback never uses Trillion's icon or a generic arrow.

The native host loads the app's **live HTTPS pages** in WebKit. Its pages, files, visitor actions and placed capabilities continue to run on the published service. This is native packaging around hosted UI, not a conversion to SwiftUI controls or an offline copy. Top-level navigation stays on the project's exact origin; external HTTPS links open outside the app. It has no Trillion account bridge, local computer reader, camera or microphone permission. Signed-in placements are rejected until a native sign-in return for the target bundle is implemented. A server failure shows a local retry screen named for the app, without displaying Trillion's generic service error inside a customer's app; the live page still has to recover before it can paint.

## Native SwiftUI source

A source folder with `native-app-source.json` can build a genuine SwiftUI screen for iPhone and Mac. The manifest lists the complete Swift and resource files and names a zero-argument SwiftUI `View` type to open:

```json
{
  "schema": "trillion.native-source",
  "entry": { "id": "home", "type": "HomeView", "source_path": "App/HomeView.swift" },
  "swift": ["App/HomeView.swift"],
  "resources": []
}
```

`scripts/build-native-source-app.mjs` reads only these files, rejects symlinks and another `@main` app entry, records a BLAKE3 source revision, and generates a source-neutral app project with `native-screen` output. A saved project may be passed back through `--project`; its source revision and screen reference must still match the current files. Without one, the script generates the project from the source:

```sh
node scripts/build-native-source-app.mjs --source-root /absolute/source/folder \
  --id my-native-app --name "My Native App" --bundle-id ai.example.my-native-app \
  --target both --build
```

This compiles supplied native source. It does not translate HTML, JavaScript, a website backend, an existing app's sign-in, or platform entitlements into SwiftUI. The explicit source manifest currently supports one home view and files that compile for the selected targets. Signing and distribution remain with the app owner.
