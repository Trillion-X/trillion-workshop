// Purpose: JavaScriptCore realization entry for the Local Files package.
// Invariants: Local Files owns file-list projection and emits generic native
// snapshot operations; Screen Arrangement only mounts this package artifact.

(function () {
  var TARGET_INVOKE_OPERATION = "runtime.target.invoke";
  var SNAPSHOT_REPLACE_OPERATION = "native.view.snapshot.replace";
  var SNAPSHOT_DISPOSE_OPERATION = "native.view.snapshot.dispose";
  var LIST_DIRECTORY_TARGET = "local.files.list-directory";

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === "string"
      ? record.lifecycle_key
      : "component:local-files-tree:jscore";
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children),
    };
  }

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: String(value || ""),
      size: size,
      weight: weight || "regular",
      color: color || "darkTextPrimary",
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node("text", props, []);
  }

  function button(label, action, accent) {
    return node(
      "box",
      {
        background: accent ? "#123653" : "darkSurfaceRaised",
        border: accent ? "#2a6fb8" : "darkBorder",
        borderWidth: 1,
        cornerRadius: 14,
        padding: 10,
        fillWidth: false,
        press: action,
      },
      [text(label, 12, "semibold", accent ? "#9fcbff" : "darkTextPrimary", 1)],
    );
  }

  function runtimeTarget(mount, target, payload) {
    var responseText = mount.invoke(
      TARGET_INVOKE_OPERATION,
      JSON.stringify({
        target: target,
        payload: payload,
      }),
    );
    if (!responseText) return {};
    return JSON.parse(responseText);
  }

  function listDirectory(mount, path) {
    return runtimeTarget(mount, LIST_DIRECTORY_TARGET, {
      path: path || "",
      limit: 60,
    });
  }

  function shortPath(value) {
    if (!value) return "/";
    return "/" + String(value).replace(/^\/+/, "");
  }

  function fileMeta(entry) {
    if (entry.is_dir) return "Folder";
    if (typeof entry.byte_length === "number") {
      if (entry.byte_length >= 1024 * 1024) {
        return Math.round(entry.byte_length / (1024 * 1024)) + " MB";
      }
      if (entry.byte_length >= 1024) {
        return Math.round(entry.byte_length / 1024) + " KB";
      }
      return String(entry.byte_length) + " bytes";
    }
    return "File";
  }

  function badge(entry) {
    return node(
      "box",
      {
        background: entry.is_dir ? "#14213a" : "darkSurface",
        border: entry.is_dir ? "#2a6fb8" : "darkBorder",
        borderWidth: 1,
        cornerRadius: 11,
        padding: 7,
        fillWidth: false,
      },
      [text(entry.is_dir ? "FO" : "FI", 10, "bold", "accent", 1)],
    );
  }

  function entryCard(entry) {
    return node(
      "box",
      {
        background: "darkSurfaceRaised",
        border: "darkBorder",
        borderWidth: 1,
        cornerRadius: 15,
        padding: 12,
        spacing: 8,
      },
      [
        node("stack", { axis: "horizontal", spacing: 10 }, [
          badge(entry),
          node("stack", { axis: "vertical", spacing: 3 }, [
            text(entry.name || entry.path || "Untitled", 14, "semibold", "darkTextPrimary", 2),
            text(fileMeta(entry), 11, "regular", "darkTextSecondary", 1),
          ]),
        ]),
      ],
    );
  }

  function entriesList(entries) {
    if (!entries.length) {
      return node(
        "box",
        {
          background: "darkSurfaceRaised",
          border: "darkBorder",
          borderWidth: 1,
          cornerRadius: 15,
          padding: 14,
          spacing: 5,
        },
        [
          text("No visible files yet", 14, "semibold", "darkTextPrimary", 1),
          text("This Bitfield folder is open, but the current directory has no visible entries.", 12, "regular", "darkTextSecondary", 3),
        ],
      );
    }
    return node(
      "stack",
      { axis: "vertical", spacing: 9 },
      entries.slice(0, 60).map(entryCard),
    );
  }

  function buildSnapshot(key, listing, errorText) {
    var entries = arrayOrEmpty(listing.items).map(objectOrEmpty);
    return {
      schema: "bitfield.native.view.snapshot",
      lifecycle_key: key,
      root: node(
        "screen",
        {
          background: "darkBackground",
          cornerRadius: 0,
          minHeight: 620,
          padding: 16,
          spacing: 12,
        },
        [
          node("stack", { axis: "horizontal", spacing: 8 }, [
            text("Local Files", 24, "bold", "darkTextPrimary", 1),
            button("Refresh", { operation: "screen.scene.reload", payload: {} }, true),
          ]),
          text(
            "This device's Bitfield folder",
            13,
            "regular",
            "darkTextSecondary",
            2,
          ),
          text(shortPath(listing.path), 12, "regular", "darkTextSecondary", 1),
          errorText
            ? text(errorText, 12, "regular", "#ff6b6b", 6)
            : entriesList(entries),
        ],
      ),
    };
  }

  function mountLocalFiles(record, mount) {
    var key = lifecycleKey(record);
    var listing = {};
    var errorText = "";
    try {
      listing = listDirectory(mount, "");
    } catch (error) {
      errorText = String(error && error.message ? error.message : error);
    }
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(key, listing, errorText)));
    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      },
    };
  }

  globalThis.bitfieldMount = mountLocalFiles;
  globalThis.mount = mountLocalFiles;
})();
