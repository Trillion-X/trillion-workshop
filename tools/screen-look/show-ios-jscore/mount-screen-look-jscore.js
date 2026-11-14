import '../read-data/resolve-screen-look-palette.js';

// Purpose: JavaScriptCore realization entry for the screen-look chooser.
// Invariants: theme records, the current-look choice, and all colors stay
// package-owned; the native shell only receives generic screen operations and
// atoms. Colors are resolved through screen-look's own
// resolve-screen-look-palette.js (loaded as a jscore source dependency) — the
// chooser is painted BY the looks it lets the human choose.

(function () {
  var TARGET_INVOKE_BACKGROUND_OPERATION = "runtime.target.invoke.background";
  var SNAPSHOT_REPLACE_OPERATION = "native.view.snapshot.replace";
  var SNAPSHOT_DISPOSE_OPERATION = "native.view.snapshot.dispose";
  var PACKAGE_INPUT_READ_OPERATION = "package.input.read";
  var MOUNT_ACTION_OPERATION = "screen.mount.action";
  var WORKFLOW_TARGET = "slot::workflow";
  var UPDATE_CURRENT_ACTION = "action:update-current-screen-look";
  // Mirror read-editable-screen-look-themes.ts DEFAULT_SCREEN_LOOK so an
  // unset current look resolves to the same default the desktop uses (SSOT).
  var DEFAULT_SCREEN_LOOK = "midnight";

  function node(kind, props, children) {
    return { kind: kind, props: props || {}, children: children || [] };
  }

  function text(value, size, weight, color, lineLimit) {
    var props = { text: value, size: size, color: color };
    if (weight) props.weight = weight;
    if (lineLimit) props.lineLimit = lineLimit;
    return node("text", props, []);
  }

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value) {
    return typeof value === "string" && value.trim().length > 0
      ? value
      : null;
  }

  function readPackageInput(mount, inputName, params) {
    var request = { package_name: "screen-look", input_name: inputName };
    if (params) request.params = params;
    var replyText = mount.invoke(
      PACKAGE_INPUT_READ_OPERATION,
      JSON.stringify(request),
    );
    try {
      var reply = JSON.parse(replyText || "{}");
      return reply && reply.found ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  // The editable-screen-look-themes cell_table yields {address, payload} rows
  // (matching-records / publish-screen-look writes address + payload_json).
  // Mirror the desktop reader's readPayload so the theme fields are read from the
  // payload, not the row wrapper.
  function readThemeRowPayload(row) {
    var obj = objectOrEmpty(row);
    return obj.payload &&
      typeof obj.payload === "object" &&
      !Array.isArray(obj.payload)
      ? obj.payload
      : obj;
  }

  function loadThemes(mount) {
    var themes = arrayOrEmpty(
      readPackageInput(mount, "editable-screen-look-themes"),
    )
      .map(readThemeRowPayload)
      .filter(function (theme) {
        return (
          objectOrEmpty(theme).kind === "screen-look-editable-theme" &&
          readString(objectOrEmpty(theme).id)
        );
      });
    return themes;
  }

  function loadCurrentLookName(mount) {
    var current = readPackageInput(mount, "current-screen-look");
    if (typeof current === "string" && current.trim()) return current.trim();
    var rows = arrayOrEmpty(current);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      return readString(objectOrEmpty(row).name) || DEFAULT_SCREEN_LOOK;
    }
    return DEFAULT_SCREEN_LOOK;
  }

  function chooseAction(themeId) {
    return {
      operation: MOUNT_ACTION_OPERATION,
      payload: { kind: "choose-screen-look", theme_id: themeId },
    };
  }

  // The stored-bytes build prepends resolve-screen-look-palette.js, so this
  // adapter consumes the exact same pure resolver as the browser.
  function resolvedTheme(theme) {
    return ScreenLookPalette.resolveScreenLookPalette(theme) || {};
  }
  function swatchPrimary(theme) {
    return resolvedTheme(theme)["--accent-primary"] || "#38bdf8";
  }
  function swatchSurface(theme) {
    return resolvedTheme(theme)["--bg-surface"] || "#1f2937";
  }

  function themeRow(theme, isCurrent, palette) {
    var primary = swatchPrimary(theme);
    var surface = swatchSurface(theme);
    return node(
      "box",
      {
        background: isCurrent ? palette.glassActive : palette.surfaceRaised,
        border: isCurrent ? palette.borderSecondary : palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 12,
        padding: 12,
        press: chooseAction(theme.id),
      },
      [
        node("stack", { axis: "horizontal", spacing: 10 }, [
          // Swatch pair: the theme's own primary + surface colors.
          node(
            "box",
            {
              background: primary,
              borderWidth: 0,
              cornerRadius: 8,
              padding: 8,
              fillWidth: false,
            },
            [],
          ),
          node(
            "box",
            {
              background: surface,
              border: palette.borderPrimary,
              borderWidth: 1,
              cornerRadius: 8,
              padding: 8,
              fillWidth: false,
            },
            [],
          ),
          node("stack", { axis: "vertical", spacing: 2 }, [
            text(
              theme.name || theme.id,
              palette.typography.heading,
              "semibold",
              palette.textPrimary,
              1,
            ),
            theme.description
              ? text(theme.description, palette.typography.caption, "regular", palette.textSecondary, 2)
              : null,
          ].filter(Boolean)),
          node("spacer", {}, []),
          isCurrent
            ? node("icon", { name: "checkmark", size: 13, color: palette.accent, weight: "semibold" }, [])
            : null,
        ].filter(Boolean)),
      ],
    );
  }

  function resolvePaletteSafe(mount, currentName) {
    // Resolve the CURRENT look's SEMANTIC palette so the chooser cards/chrome
    // recolor with the selected screen look (was resolve(mount) — the resolver
    // wants a THEME, not the mount, so it always fell through to the default
    // blue, making the cards "weird blue all the time"). The shared
    // resolveScreenLookNamedPalette maps the theme tokens to named slots; we
    // pick the current theme out of the same unwrapped list the rows render.
    try {
      var name = currentName || loadCurrentLookName(mount);
      var themes = loadThemes(mount);
      var theme = null;
      for (var i = 0; i < themes.length; i += 1) {
        if (
          readString(themes[i].id) === name ||
          readString(themes[i].name) === name
        ) {
          theme = themes[i];
          break;
        }
      }
      var resolved = ScreenLookPalette.resolveScreenLookNamedPalette(theme);
      if (resolved) {
        resolved.typography = ScreenLookPalette.resolveScreenLookTypography(theme);
        return resolved;
      }
    } catch (error) {
      // fall through to resolver defaults below
    }
    var fallback = ScreenLookPalette.resolveScreenLookNamedPalette(null);
    fallback.typography = ScreenLookPalette.resolveScreenLookTypography(null);
    return fallback;
  }

  function buildSnapshot(key, mount, optimisticCurrent) {
    // Optimistic selection: a just-tapped theme highlights AND recolors the
    // cards immediately, before the background update-current-screen-look
    // persist lands (a fresh read would still see the OLD value).
    // loadCurrentLookName confirms on relaunch.
    var current = optimisticCurrent || loadCurrentLookName(mount);
    var palette = resolvePaletteSafe(mount, current);
    var themes = loadThemes(mount);
    var rows = themes.map(function (theme) {
      return themeRow(theme, theme.id === current, palette);
    });
    var body = rows.length
      ? node("stack", { axis: "vertical", spacing: 8 }, rows)
      : node(
          "box",
          {
            background: palette.surfaceRaised,
            border: palette.borderPrimary,
            borderWidth: 1,
            cornerRadius: 12,
            padding: 16,
          },
          [text("No screen looks yet.", palette.typography.body, "regular", palette.textSecondary)],
        );
    return {
      schema: "bitfield.native.view.snapshot",
      lifecycle_key: key,
      root: node(
        "box",
        { borderWidth: 0, padding: 12, spacing: 12, fillHeight: true },
        [
          text("Screen look", palette.typography.headingLg, "semibold", palette.textPrimary, 1),
          node("scroll", { axis: "vertical", spacing: 0 }, [body]),
        ],
      ),
    };
  }

  function updateCurrentOperation(themeId) {
    return {
      target: WORKFLOW_TARGET,
      payload: {
        operation: "execute_definition",
        definition_id: UPDATE_CURRENT_ACTION,
        include_steps: false,
        include_output: false,
        input: { value: themeId },
      },
    };
  }

  globalThis.bitfieldMount = function bitfieldMount(record, mount) {
    var key =
      readString(objectOrEmpty(record).lifecycle_key) || "screen-look-chooser";
    // The owner surface (the container that placed this chooser) passes its
    // root lifecycle key so a pick can recolor the owner's chrome on the spot.
    var ownerReloadKey = readString(
      objectOrEmpty(objectOrEmpty(record).props).ownerReloadKey,
    );
    var snapshot = buildSnapshot(key, mount);
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));

    globalThis.bitfieldOnAction = function bitfieldOnAction(payloadText) {
      var payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        return;
      }
      if (
        !payload ||
        payload.kind !== "choose-screen-look" ||
        !readString(payload.theme_id)
      ) {
        return;
      }
      // Persist FIRST (ordered background lane), then re-render from the
      // re-read inputs so the checkmark and palette follow the new look.
      mount.invoke(
        TARGET_INVOKE_BACKGROUND_OPERATION,
        JSON.stringify(updateCurrentOperation(payload.theme_id)),
      );
      snapshot = buildSnapshot(key, mount, payload.theme_id);
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
      // Recolor the owner's chrome on the spot: address an apply-look action
      // back to the surface that placed this chooser, carrying the picked theme
      // so the owner recolors optimistically (no wait for the durable write).
      // The host routes by target_lifecycle_key (screen.mount.action).
      if (ownerReloadKey) {
        mount.invoke(
          MOUNT_ACTION_OPERATION,
          JSON.stringify({
            target_lifecycle_key: ownerReloadKey,
            kind: "apply-look",
            theme_id: payload.theme_id,
          }),
        );
      }
    };

    return {
      dispose: function dispose() {
        if (globalThis.bitfieldOnAction) delete globalThis.bitfieldOnAction;
        mount.invoke(
          SNAPSHOT_DISPOSE_OPERATION,
          JSON.stringify({ lifecycle_key: key }),
        );
      },
    };
  };
})();
