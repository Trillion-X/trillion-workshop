// Purpose: JavaScriptCore realization entry for the screen-arrangement package.
// Invariants: layout, placement, tab, split, overlay, and saved-layout behavior
// stay package-owned; the native shell only receives generic screen operations.
// Colors are resolved ONCE through screen-look's resolve-screen-look-palette.js
// (loaded as a jscore source dependency) — zero hardcoded design values here.
// The design is the canonical container design: tab pills with close glyphs,
// icon toolbar (split-h / split-v / PiP / maximize / close), a real recursive
// weighted-split tree with drag-resize rails, a pan/zoom canvas float layer,
// and a draggable/resizable PiP overlay layer.

(function () {
  var TARGET_INVOKE_OPERATION = "runtime.target.invoke";
  var TARGET_INVOKE_BACKGROUND_OPERATION = "runtime.target.invoke.background";
  var SNAPSHOT_REPLACE_OPERATION = "native.view.snapshot.replace";
  var SNAPSHOT_DISPOSE_OPERATION = "native.view.snapshot.dispose";
  var SCREEN_PUT_THING_OPERATION = "screen.put-thing";
  var PACKAGE_INPUT_READ_OPERATION = "package.input.read";
  var MOUNT_ACTION_OPERATION = "screen.mount.action";
  var ENGINE_LABEL_TARGET = "engine.operation.label-addressed";
  var WRITE_BATCH_OPERATION = "engine.operation.write-batch";
  var SCREEN_COMMAND_CAPABILITY =
    "can-put-thing-on-screen-using-screen-commands";
  var PACKAGE_NAME = "screen-arrangement";
  var WORKFLOW_TARGET = "slot::workflow";
  var SLOT_TARGET = "slot::screen-arrangement";
  var ADDRESS_MODE_LABEL_HASH = "label_hash";
  var LAYOUT_STATE_VALUE_ADDRESS_LABEL = "screen-arrangement-layout-state";
  var LAYOUT_STATE_RECORD_PATH = ["current-item", "published-record"];
  var SAVE_LAYOUT_PRESET_ACTION = "action:save-layout-preset";
  var ARCHIVE_LAYOUT_PRESET_ACTION = "action:archive-layout-preset";
  // The root lifecycle key, captured at mount so placed child surfaces (the
  // screen-look chooser) can address an action back to this owner to recolor
  // the chrome the instant a shared look changes.
  var ownerReloadKeyForChildren = null;
  var PUBLISH_LAYOUT_PRESETS_ACTION = "action:publish-layout-presets";
  var PUBLISH_PLACEABLE_SURFACES_ACTION = "action:publish-placeable-surfaces";

  var DEFAULT_LAYOUT_STATE = {
    containers: { main: { id: "main", groupId: "main-group" } },
    tabGroups: {
      "main-group": {
        tabIds: ["surface-default"],
        activeTabId: "surface-default",
      },
    },
    tabs: {
      "surface-default": {
        id: "surface-default",
        title: "Empty tab",
        target: null,
        icon: "Square",
      },
    },
    layouts: [
      { type: "tiled", root: { kind: "leaf", containerId: "main" } },
      { type: "floating", containers: [], camera: { scale: 1, tx: 0, ty: 0 } },
      { type: "overlay", containers: [] },
    ],
    surface: "grid",
    focusedContainerId: "main",
    maximizedContainerId: null,
    arrangementMenuOpen: false,
  };

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === "string"
      ? record.lifecycle_key
      : "component:screen-arrangement:jscore";
  }

  function node(kind, props, children) {
    var built = {
      kind: kind,
      props: objectOrEmpty(props),
      // Conditional renders return null (e.g. dropZoneOverlay when no drag
      // is active) — drop them HERE, the one place every child flows
      // through. A literal null child fails the shell's snapshot decode.
      children: arrayOrEmpty(children).filter(Boolean),
    };
    // Stable view identity: SwiftUI keys @State (live gesture frames,
    // optimistic holds) to node identity. Without an id every snapshot
    // replace mints new identities — any re-render mid-gesture resets the
    // window to its declared frame and the drag "fights back" (jitter).
    if (built.props.id) built.id = readString(built.props.id);
    return built;
  }

  // Weight names map to the shell's concrete CSS-scale numbers (the shell
  // accepts numbers only — no name vocabulary crosses the boundary).
  var FONT_WEIGHTS = {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    heavy: 800,
  };

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: String(value || ""),
      size: size,
      weight: FONT_WEIGHTS[weight] || readNumber(weight, 400),
      color: color,
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node("text", props, []);
  }

  function icon(name, size, color, weight) {
    return node(
      "icon",
      {
        name: name,
        size: size,
        color: color,
        weight: FONT_WEIGHTS[weight] || readNumber(weight, 500),
      },
      [],
    );
  }

  function badge(label, palette) {
    return node(
      "box",
      {
        background: palette.surfaceRaised,
        border: palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 11,
        padding: 7,
        fillWidth: false,
      },
      [
        text(
          String(label || "SA")
            .slice(0, 2)
            .toUpperCase(),
          10,
          "bold",
          palette.accent,
        ),
      ],
    );
  }

  function readString(value) {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  function readFirstString(record, keys) {
    for (var i = 0; i < keys.length; i += 1) {
      var value = readString(record && record[keys[i]]);
      if (value) return value;
    }
    return null;
  }

  function readNumber(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }


  function readStringArray(value) {
    return arrayOrEmpty(value)
      .filter(function (item) {
        return typeof item === "string" && item.trim().length > 0;
      })
      .map(function (item) {
        return item.trim();
      });
  }

  function makeId(prefix, seed) {
    var source =
      String(seed || prefix || "item")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 42) ||
      prefix ||
      "item";
    return (
      source +
      "-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 7)
    );
  }

  function readPackageInput(mount, inputName, params) {
    var request = {
      package_name: PACKAGE_NAME,
      input_name: inputName,
    };
    if (params && typeof params === "object") request.params = params;
    var responseText = mount.invoke(
      PACKAGE_INPUT_READ_OPERATION,
      JSON.stringify(request),
    );
    if (!responseText) return null;
    var reply = JSON.parse(responseText);
    return reply && reply.found !== false ? reply.value : null;
  }

  function readPackageInputArray(mount, inputName) {
    return arrayOrEmpty(readPackageInput(mount, inputName));
  }

  function readPackageInputRows(mount, inputName) {
    return arrayOrEmpty(readPackageInput(mount, inputName)).map(function (row) {
      return { payload: objectOrEmpty(row) };
    });
  }

  function payloadOf(item) {
    if (item && item.kind === "placeable-surface") return objectOrEmpty(item);
    return objectOrEmpty(item && item.payload);
  }

  function sourcePackageOf(item) {
    return (
      readString(item && item.source_package) ||
      readString(item && item.sourcePackage) ||
      readSourcePackageFromAddress(readString(item && item.address))
    );
  }

  function readSourcePackageFromAddress(address) {
    if (!address) return null;
    var match = /^(?:package|published-record)::([^:]+)::/.exec(address);
    return match && match[1] ? match[1] : null;
  }

  function readEntryName(value) {
    if (!value) return null;
    return value.indexOf("component:") === 0
      ? value.slice("component:".length)
      : value;
  }

  function readPackageNameFromPackageAddress(value) {
    var text = readString(value);
    if (!text) return null;
    var match = /^package::([^:]+)::/.exec(text);
    return match && match[1] ? match[1] : null;
  }

  function readPackageEntry(payload, item, materialTarget) {
    var declared = objectOrEmpty(payload.package_entry || payload.packageEntry);
    var packageName =
      readString(declared.package_name) ||
      readString(declared.packageName) ||
      readString(payload.package) ||
      readPackageNameFromPackageAddress(payload.factflow_ref) ||
      readPackageNameFromPackageAddress(payload.factflowRef) ||
      sourcePackageOf(item);
    var entryName =
      readString(declared.entry_name) ||
      readString(declared.entryName) ||
      readEntryName(
        readFirstString(payload, ["entry_name", "entryName"]) || materialTarget,
      );
    return packageName && entryName
      ? { packageName: packageName, entryName: entryName }
      : null;
  }

  function normalizePublishedRecord(item, index) {
    var payload = payloadOf(item);
    if (!Object.keys(payload).length && item && item.kind) payload = item;
    return {
      recordId:
        readString(item && item.address) ||
        readString(payload.id) ||
        "published-record-" + index,
      payload: payload,
      row: item,
      sourcePackage: sourcePackageOf(item),
    };
  }

  function readPlaceableSurface(item, index) {
    var record = normalizePublishedRecord(item, index);
    var payload = record.payload;
    if (readString(payload.kind) !== "placeable-surface") return null;
    if (payload.disabled === true) return null;
    var materialTarget = readFirstString(payload, [
      "material_target",
      "materialTarget",
      "surface_target",
      "surfaceTarget",
      "address_to_ask",
      "addressToAsk",
      "address",
      "target",
    ]);
    if (!materialTarget) return null;
    var surfaceInput = payload.surfaceInput || payload.surface_input;
    return {
      id:
        readFirstString(payload, ["id", "surface_id", "surfaceId"]) ||
        record.recordId,
      label:
        readFirstString(payload, ["label", "title", "name"]) || materialTarget,
      target:
        readFirstString(payload, [
          "target",
          "address_to_ask",
          "addressToAsk",
          "address",
        ]) || null,
      packageEntry: readPackageEntry(payload, item, materialTarget),
      materialTarget: materialTarget,
      icon: readFirstString(payload, ["icon"]) || "Square",
      badge: readFirstString(payload, ["badge"]) || null,
      order: readNumber(payload.order, index),
      routePaths: readStringArray(payload.route_paths || payload.routePaths),
      routePrefixes: readStringArray(
        payload.route_prefixes || payload.routePrefixes,
      ),
      acceptsMaterialKinds: readStringArray(
        payload.accepts_material_kinds || payload.acceptsMaterialKinds,
      ),
      surfaceInput: objectOrEmpty(surfaceInput),
      payload: payload,
    };
  }

  function loadPlaceableSurfaces(records) {
    var surfaces = [];
    for (var i = 0; i < records.length; i += 1) {
      var surface = readPlaceableSurface(records[i], i);
      if (surface) surfaces.push(surface);
    }
    return surfaces;
  }

  function normalizeLayoutGraph(state) {
    if (!Object.keys(state.containers).length) {
      state.containers = clone(DEFAULT_LAYOUT_STATE.containers);
      state.tabGroups = clone(DEFAULT_LAYOUT_STATE.tabGroups);
      state.tabs = clone(DEFAULT_LAYOUT_STATE.tabs);
    }
    var containerIds = Object.keys(state.containers);
    var usedGroups = {};
    var assignedTabs = {};
    var nextGroups = {};
    var nextTabs = {};

    for (var i = 0; i < containerIds.length; i += 1) {
      var container = state.containers[containerIds[i]];
      if (!container || !container.groupId) continue;
      usedGroups[container.groupId] = true;
    }

    Object.keys(usedGroups).forEach(function (groupId) {
      var rawGroup = state.tabGroups[groupId] || {
        tabIds: [],
        activeTabId: null,
      };
      var rawTabIds = arrayOrEmpty(rawGroup.tabIds || rawGroup.tab_ids);
      var tabIds = [];
      for (var index = 0; index < rawTabIds.length; index += 1) {
        var tabId = readString(rawTabIds[index]);
        if (!tabId || !state.tabs[tabId] || assignedTabs[tabId]) continue;
        assignedTabs[tabId] = true;
        tabIds.push(tabId);
        nextTabs[tabId] = state.tabs[tabId];
      }
      var activeTabId = readString(
        rawGroup.activeTabId || rawGroup.active_tab_id,
      );
      nextGroups[groupId] = {
        tabIds: tabIds,
        activeTabId:
          activeTabId && tabIds.indexOf(activeTabId) >= 0
            ? activeTabId
            : tabIds[0] || null,
      };
    });

    state.tabGroups = nextGroups;
    state.tabs = nextTabs;
    if (
      !state.focusedContainerId ||
      !state.containers[state.focusedContainerId]
    ) {
      state.focusedContainerId = containerIds[0] || null;
    }
    if (
      state.maximizedContainerId &&
      !state.containers[state.maximizedContainerId]
    ) {
      state.maximizedContainerId = null;
    }
    return state;
  }

  // Gesture-written geometry arrives as {frame:{x,y,w,h}} (one marker
  // substitution) on floating/overlay containers, and as a bare {scale,tx,ty}
  // camera. Flatten frames and restore camera bounds so the rest of the state
  // machine always sees one canonical shape.
  function normalizeLayouts(layouts) {
    return arrayOrEmpty(layouts).map(function (layout) {
      if (!layout || typeof layout !== "object") return layout;
      if (layout.type === "floating" || layout.type === "overlay") {
        layout.containers = arrayOrEmpty(layout.containers).map(
          function (entry) {
            var normalized = objectOrEmpty(entry);
            var frame = objectOrEmpty(normalized.frame);
            if (Object.keys(frame).length) {
              normalized.x = readNumber(frame.x, readNumber(normalized.x, 18));
              normalized.y = readNumber(frame.y, readNumber(normalized.y, 18));
              normalized.w = readNumber(frame.w, readNumber(normalized.w, 320));
              normalized.h = readNumber(frame.h, readNumber(normalized.h, 380));
              delete normalized.frame;
            }
            return normalized;
          },
        );
      }
      if (layout.type === "floating") {
        var camera = objectOrEmpty(layout.camera);
        layout.camera = {
          scale: readNumber(camera.scale, 1),
          tx: readNumber(camera.tx, 0),
          ty: readNumber(camera.ty, 0),
          min: readNumber(camera.min, 0.2),
          max: readNumber(camera.max, 3),
        };
      }
      return layout;
    });
  }

  function normalizeLayoutState(raw) {
    var source = objectOrEmpty(raw);
    var state = clone(DEFAULT_LAYOUT_STATE);
    state.containers = objectOrEmpty(source.containers);
    if (!Object.keys(state.containers).length)
      state.containers = clone(DEFAULT_LAYOUT_STATE.containers);
    state.tabGroups = objectOrEmpty(source.tabGroups || source.tab_groups);
    if (!Object.keys(state.tabGroups).length)
      state.tabGroups = clone(DEFAULT_LAYOUT_STATE.tabGroups);
    state.tabs = objectOrEmpty(source.tabs);
    if (!Object.keys(state.tabs).length)
      state.tabs = clone(DEFAULT_LAYOUT_STATE.tabs);
    state.layouts = arrayOrEmpty(source.layouts).length
      ? normalizeLayouts(clone(source.layouts))
      : clone(DEFAULT_LAYOUT_STATE.layouts);
    state.surface = source.surface === "canvas" ? "canvas" : "grid";
    state.focusedContainerId =
      readString(source.focusedContainerId || source.focused_container_id) ||
      Object.keys(state.containers)[0] ||
      null;
    state.maximizedContainerId = readString(
      source.maximizedContainerId || source.maximized_container_id,
    );
    state.arrangementMenuOpen =
      source.arrangementMenuOpen === true ||
      source.arrangement_menu_open === true;
    return normalizeLayoutGraph(state);
  }

  function decodeLayoutState(value) {
    var payload = objectOrEmpty(value && value.payload);
    var source = Object.keys(payload).length ? payload : objectOrEmpty(value);
    if (!Object.keys(source).length)
      return normalizeLayoutState(DEFAULT_LAYOUT_STATE);
    return normalizeLayoutState(source);
  }

  function countLeafNodes(node) {
    if (!node) return 0;
    if (node.kind === "leaf") return 1;
    return arrayOrEmpty(node.children).reduce(function (sum, child) {
      return sum + countLeafNodes(child);
    }, 0);
  }

  function layoutStateRichnessScore(state) {
    var containers = objectOrEmpty(state.containers);
    var tabGroups = objectOrEmpty(state.tabGroups);
    var tabs = objectOrEmpty(state.tabs);
    var layouts = arrayOrEmpty(state.layouts);
    var tiled = layouts.filter(function (layout) {
      return layout && layout.type === "tiled";
    })[0];
    var floating = layouts.filter(function (layout) {
      return layout && layout.type === "floating";
    })[0];
    var overlay = layouts.filter(function (layout) {
      return layout && layout.type === "overlay";
    })[0];
    var materializedTabCount = Object.keys(tabs).filter(function (tabId) {
      var tab = tabs[tabId];
      return !!(
        tab &&
        (readString(tab.target) ||
          objectOrEmpty(tab.packageEntry || tab.package_entry).packageName ||
          readString(tab.materialTarget || tab.material_target))
      );
    }).length;
    return (
      materializedTabCount * 10000 +
      Object.keys(containers).length * 1000 +
      Object.keys(tabs).length * 100 +
      Object.keys(tabGroups).length * 50 +
      countLeafNodes(tiled && tiled.root ? tiled.root : null) * 10 +
      arrayOrEmpty(floating && floating.containers).length * 5 +
      arrayOrEmpty(overlay && overlay.containers).length * 3 +
      (state.surface === "canvas" ? 1 : 0)
    );
  }


  function decodeLayoutPresets(items) {
    var grouped = {};
    for (var i = 0; i < items.length; i += 1) {
      var payload = payloadOf(items[i]);
      var subjectId = readString(payload.subject_id);
      var propertyId = readString(payload.property_id);
      if (!subjectId || !propertyId) continue;
      grouped[subjectId] = grouped[subjectId] || {};
      grouped[subjectId][propertyId] =
        payload.value_json !== undefined ? payload.value_json : payload.value;
    }
    var presets = [];
    Object.keys(grouped).forEach(function (id) {
      var properties = grouped[id];
      if (properties["prop:layout_preset:status"] === "archived") return;
      var layout = properties["prop:layout_preset:layout"];
      var name = readString(properties["prop:layout_preset:name"]);
      if (!name || !layout) return;
      presets.push({
        id: id,
        name: name,
        starred: properties["prop:layout_preset:starred"] === true,
        order: readNumber(
          properties["prop:layout_preset:order"],
          Number.MAX_SAFE_INTEGER,
        ),
        createdAt:
          readString(properties["prop:layout_preset:created_at"]) || "",
        updatedAt:
          readString(properties["prop:layout_preset:updated_at"]) || "",
        layout: normalizeLayoutState(layout),
      });
    });
    return presets.sort(function (left, right) {
      return (
        Number(right.starred) - Number(left.starred) ||
        left.order - right.order ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      );
    });
  }

  function tiledLayout(state) {
    return (
      state.layouts.filter(function (layout) {
        return layout && layout.type === "tiled";
      })[0] || { type: "tiled", root: null }
    );
  }

  function floatingLayout(state) {
    return (
      state.layouts.filter(function (layout) {
        return layout && layout.type === "floating";
      })[0] || {
        type: "floating",
        containers: [],
        camera: { scale: 1, tx: 0, ty: 0 },
      }
    );
  }

  function overlayLayout(state) {
    return (
      state.layouts.filter(function (layout) {
        return layout && layout.type === "overlay";
      })[0] || { type: "overlay", containers: [] }
    );
  }

  function replaceSurfaceLayout(state, nextLayout) {
    state.layouts = state.layouts.filter(function (layout) {
      return layout.type !== nextLayout.type;
    });
    if (nextLayout.type === "tiled") state.layouts.unshift(nextLayout);
    else state.layouts.push(nextLayout);
    return state;
  }

  function containerOrderFromTree(node, out) {
    if (!node) return out;
    if (node.kind === "leaf") {
      if (node.containerId) out.push(node.containerId);
      return out;
    }
    arrayOrEmpty(node.children).forEach(function (child) {
      containerOrderFromTree(child, out);
    });
    return out;
  }

  function containerIdsForState(state) {
    var ordered = containerOrderFromTree(tiledLayout(state).root, []);
    Object.keys(state.containers).forEach(function (containerId) {
      if (ordered.indexOf(containerId) < 0) ordered.push(containerId);
    });
    return ordered;
  }


  function groupForContainer(state, containerId) {
    var container = state.containers[containerId];
    return container ? state.tabGroups[container.groupId] : null;
  }

  function activeTabIdForContainer(state, containerId) {
    var group = groupForContainer(state, containerId);
    return group ? group.activeTabId : null;
  }

  function activeTabForContainer(state, containerId) {
    var tabId = activeTabIdForContainer(state, containerId);
    return tabId ? state.tabs[tabId] || null : null;
  }

  function makeEmptyTab() {
    return {
      id: makeId("tab", "empty-tab"),
      title: "Empty tab",
      target: null,
      icon: "Square",
    };
  }

  function tabPatchForSurface(surface) {
    return {
      title: surface.label,
      target: surface.target || null,
      packageEntry: surface.packageEntry || null,
      materialTarget: surface.materialTarget,
      icon: surface.icon || "Square",
      closable: true,
      metadata: {
        placeable_surface_id: surface.id,
        placeable_surface_material_target: surface.materialTarget,
        surfaceInput: surface.surfaceInput || {},
      },
    };
  }

  function tabForSurface(surface) {
    var tab = tabPatchForSurface(surface);
    tab.id = makeId(
      "tab",
      surface.id || surface.materialTarget || surface.label,
    );
    return tab;
  }

  function isEmptyTab(tab) {
    return !!tab && !tab.target && !tab.packageEntry && !tab.materialTarget;
  }







  function replaceLeaf(node, targetContainerId, replacement) {
    if (!node) return null;
    if (node.kind === "leaf" && node.containerId === targetContainerId)
      return replacement;
    if (node.kind !== "split") return node;
    return {
      kind: "split",
      dir: node.dir,
      sizes: arrayOrEmpty(node.sizes),
      children: arrayOrEmpty(node.children).map(function (child) {
        return replaceLeaf(child, targetContainerId, replacement);
      }),
    };
  }









  // ---------------------------------------------------------------------------
  // Gesture-written state: the shell substitutes {"$kind":"screen.gesture.value"}
  // with the final geometry (sizes array / frame object / camera object) inside
  // the save-layout-state input. The marker is planted at the exact spot in the
  // serialized layouts where that geometry lives, so a resize/drag/camera
  // gesture writes ONE canonical layout state — no shell knowledge of meaning.
  // ---------------------------------------------------------------------------

  function gestureValueMarker() {
    return { $kind: "screen.gesture.value" };
  }

  function withMarkerAtSplitPath(node, path, depth) {
    if (!node || node.kind !== "split") return node;
    var copy = {
      kind: "split",
      dir: node.dir,
      sizes: arrayOrEmpty(node.sizes),
      children: arrayOrEmpty(node.children),
    };
    if (depth === path.length) {
      copy.sizes = gestureValueMarker();
      copy.children = copy.children.map(function (child) {
        return child;
      });
      return copy;
    }
    var index = path[depth];
    copy.children = copy.children.map(function (child, childIndex) {
      return childIndex === index
        ? withMarkerAtSplitPath(child, path, depth + 1)
        : child;
    });
    return copy;
  }




  function ensureFloatingWindow(state, containerId, index) {
    var next = normalizeLayoutState(clone(state));
    var floating = clone(floatingLayout(next));
    var exists = arrayOrEmpty(floating.containers).some(function (entry) {
      return entry.containerId === containerId;
    });
    if (!exists) {
      floating.containers = arrayOrEmpty(floating.containers).concat([
        {
          containerId: containerId,
          x: 24 + index * 36,
          y: 24 + index * 44,
          w: 330,
          h: 420,
          z: floating.containers.length + 1,
        },
      ]);
      replaceSurfaceLayout(next, floating);
    }
    return next;
  }

  function saveLayoutStateOperation(state) {
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: ENGINE_LABEL_TARGET,
        payload: {
          operation_label: WRITE_BATCH_OPERATION,
          writes: [
            {
              address_label: LAYOUT_STATE_VALUE_ADDRESS_LABEL,
              address_mode: ADDRESS_MODE_LABEL_HASH,
              path_labels: LAYOUT_STATE_RECORD_PATH,
              payload: state,
            },
          ],
        },
      },
    };
  }

  function archivePresetOperation(preset) {
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: WORKFLOW_TARGET,
        payload: {
          operation: "execute_definition",
          definition_id: ARCHIVE_LAYOUT_PRESET_ACTION,
          include_steps: false,
          include_output: false,
          input: {
            preset_id: preset.id,
            updated_at: new Date().toISOString(),
          },
        },
      },
    };
  }

  function savePresetOperation(presetId, layout, nameValue, existingPreset) {
    var now = new Date().toISOString();
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: WORKFLOW_TARGET,
        payload: {
          operation: "execute_definition",
          definition_id: SAVE_LAYOUT_PRESET_ACTION,
          include_steps: false,
          include_output: false,
          input: {
            preset_id: presetId,
            name: nameValue,
            layout: layout,
            starred: existingPreset ? existingPreset.starred : false,
            order: existingPreset ? existingPreset.order : Date.now(),
            created_at: existingPreset ? existingPreset.createdAt : now,
            updated_at: now,
          },
        },
      },
    };
  }

  function reloadOperation() {
    return {
      operation: "screen.scene.reload",
      payload: {},
    };
  }

  function savePresetAction(presetId, layout, nameValue, existingPreset) {
    return {
      operations: [
        savePresetOperation(presetId, layout, nameValue, existingPreset),
        publishLayoutPresetsOperation(),
        reloadOperation(),
      ],
    };
  }

  function inputValueMarker() {
    return { $kind: "screen.input.value" };
  }

  function tabSurfaceInput(tab) {
    var metadata = objectOrEmpty(tab && tab.metadata);
    return objectOrEmpty(metadata.surfaceInput || metadata.surface_input);
  }

  function packageEntryBytesAddressLabel(packageEntry) {
    return (
      "package::" +
      packageEntry.packageName +
      "::entry-bytes::" +
      packageEntry.entryName
    );
  }

  var packageEntrySourceCache = {};

  function readPackageEntrySourceBase64(mount, packageEntry) {
    if (!packageEntry) return null;
    var addressLabel = packageEntryBytesAddressLabel(packageEntry);
    if (
      Object.prototype.hasOwnProperty.call(
        packageEntrySourceCache,
        addressLabel,
      )
    ) {
      return packageEntrySourceCache[addressLabel];
    }
    var value = readPackageInput(
      mount,
      "package-entry-by-address-label",
      { addressLabel: addressLabel },
    );
    var payloadBase64 = objectOrEmpty(value).payload_base64;
    var resolved =
      typeof payloadBase64 === "string" && payloadBase64.length > 0
        ? { addressLabel: addressLabel, payloadBase64: payloadBase64 }
        : null;
    packageEntrySourceCache[addressLabel] = resolved;
    return resolved;
  }

  function packageEntryThingForTab(tab, mount, lifecycleKey) {
    if (!tab || !tab.packageEntry) return null;
    var source = readPackageEntrySourceBase64(mount, tab.packageEntry);
    if (!source) return null;
    return {
      source_base64: source.payloadBase64,
      source_key: source.addressLabel,
      lifecycle_key: lifecycleKey,
      required_capabilities: [SCREEN_COMMAND_CAPABILITY],
      props: {
        // Package-entry JSCore mounts export bitfieldMount (same convention as
        // the root native surface). Without this the host's
        // put-thing handler defaults to putThingOnScreen and fails to mount.
        entry_function: "bitfieldMount",
        // Lets the placed chooser address an apply-look action back to this
        // owner surface so the chrome recolors on the tap (see bitfieldOnAction).
        ownerReloadKey: ownerReloadKeyForChildren,
        materialTarget: tab.materialTarget || null,
        surfaceInput: tabSurfaceInput(tab),
        target: tab.target || null,
      },
      environment: {},
      dependencies: {},
    };
  }

  function componentThingRecordForTab(tab, records, lifecycleKey, mount) {
    if (!tab || !tab.materialTarget) return null;
    var packageEntryThing = packageEntryThingForTab(tab, mount, lifecycleKey);
    if (packageEntryThing) return packageEntryThing;
    var thing = screenCommandThingForMaterialTarget(
      tab.materialTarget,
      records,
      lifecycleKey,
    );
    if (!thing) return null;
    thing.props = Object.assign({}, objectOrEmpty(thing.props), {
      materialTarget: tab.materialTarget,
      surfaceInput: tabSurfaceInput(tab),
      target: tab.target || null,
    });
    return thing;
  }

  function hasScreenCommandThingForMaterialTarget(surface, records) {
    if (!surface) return false;
    if (surface.packageEntry) return true;
    return !!screenCommandThingForMaterialTarget(
      surface.materialTarget,
      records,
      "screen-arrangement:catalog-probe",
    );
  }

  function screenCommandThingForMaterialTarget(
    materialTarget,
    records,
    lifecycleKey,
  ) {
    if (!materialTarget) return null;
    for (var i = 0; i < records.length; i += 1) {
      var payload = payloadOf(records[i]);
      if (payload.property_id !== "prop:extension:things_to_put_on_screen")
        continue;
      if (payload.subject_id !== materialTarget) continue;
      var things = arrayOrEmpty(payload.value_json);
      for (var j = 0; j < things.length; j += 1) {
        var candidate = objectOrEmpty(things[j]);
        var caps = readStringArray(candidate.required_capabilities);
        if (caps.indexOf(SCREEN_COMMAND_CAPABILITY) < 0) continue;
        var thing = clone(candidate);
        thing.lifecycle_key = lifecycleKey;
        return thing;
      }
    }
    return null;
  }

  function regionForContainer(containerId) {
    return "container-body:" + containerId;
  }

  function activeThingLifecycleKey(containerId) {
    return "screen-arrangement:active-tab:" + containerId;
  }

  function mountOperationsForState(state, records, mount) {
    var operations = [];
    containerIdsForState(state).forEach(function (containerId) {
      var tab = activeTabForContainer(state, containerId);
      var lifecycle = activeThingLifecycleKey(containerId);
      var thing = componentThingRecordForTab(tab, records, lifecycle, mount);
      if (thing) {
        operations.push({
          operation: SCREEN_PUT_THING_OPERATION,
          payload: {
            region: regionForContainer(containerId),
            lifecycle_key: lifecycle,
            input: {
              surface: "screen",
              tab: {
                id: tab.id,
                title: tab.title,
                metadata: tab.metadata || {},
              },
              container: {
                id: containerId,
                focused: state.focusedContainerId === containerId,
                maximized: state.maximizedContainerId === containerId,
              },
            },
            thing: thing,
          },
        });
      } else {
        operations.push({
          operation: SNAPSHOT_DISPOSE_OPERATION,
          payload: { lifecycle_key: lifecycle },
        });
      }
    });
    return operations;
  }

  function publishLayoutPresetsOperation() {
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: WORKFLOW_TARGET,
        payload: {
          operation: "execute_definition",
          definition_id: PUBLISH_LAYOUT_PRESETS_ACTION,
          include_steps: false,
          include_output: false,
          input: {},
        },
      },
    };
  }

  function publishPlaceableSurfacesOperation() {
    return {
      operation: TARGET_INVOKE_OPERATION,
      payload: {
        target: WORKFLOW_TARGET,
        payload: {
          operation: "execute_definition",
          definition_id: PUBLISH_PLACEABLE_SURFACES_ACTION,
          include_steps: false,
          include_output: false,
          input: {},
        },
      },
    };
  }


  // SSOT: the mount computes NOTHING. Every interaction forwards
  // {operation, payload} to slot::screen-arrangement (the same Rust brain
  // the React arranger asks) and renders the reply state. One owner.
  function slotAction(operation, payload, includeViewport) {
    var envelope = {
      kind: "slot-operation",
      op: operation,
      args: payload || {},
    };
    // Viewport is a HOST geometry fact (same contract as the web arranger:
    // "browser-only viewport facts may be included as request input; they
    // are not arrangement policy"). The shell substitutes the marker with
    // the current screen size — blind, like screen.gesture.value.
    if (includeViewport === true) {
      envelope.viewport = { $kind: "screen.viewport.value" };
    }
    return { operation: MOUNT_ACTION_OPERATION, payload: envelope };
  }

  // A gesture that commits through two slot operations (a PiP window
  // drag/resize commits position via moveOverlay AND size via resizeOverlay
  // — the exact operation pair the React arranger uses). The shell
  // substitutes the SAME gesture geometry into every chained operation;
  // each slot op reads the fields it owns and ignores the rest.
  function slotActions(actions) {
    return { operations: actions };
  }

  // ---------------------------------------------------------------------------
  // Palette — the SSOT chain: screen-look records → resolveScreenLookPalette
  // (loaded as a jscore source dependency) → concrete values. The fallback for
  // a missing resolver is the resolver's own default theme behavior, never a
  // second hand-rolled color table.
  // ---------------------------------------------------------------------------

  function resolvePalette(mount, optimisticCurrentName) {
    var resolve =
      (globalThis.ScreenLookPalette &&
        globalThis.ScreenLookPalette.resolveScreenLookPalette) ||
      globalThis.resolveScreenLookPalette;
    var theme = { tokens: [] };
    if (typeof resolve === "function") {
      var currentRows = arrayOrEmpty(
        readNamedPackageInput(mount, "screen-look", "current-screen-look"),
      );
      var currentName = null;
      for (var i = 0; i < currentRows.length; i += 1) {
        currentName = readString(objectOrEmpty(currentRows[i]).name);
        if (currentName) break;
      }
      // Optimistic override: when a look was just picked, recolor from that
      // theme immediately instead of waiting for the durable current-look write
      // to round-trip through the cell_table (mirrors the resize liveSizes /
      // chooser checkmark optimism).
      if (optimisticCurrentName) {
        currentName = readString(optimisticCurrentName) || currentName;
      }
      var themes = arrayOrEmpty(
        readNamedPackageInput(mount, "screen-look", "editable-screen-look-themes"),
      );
      for (var t = 0; t < themes.length; t += 1) {
        // The editable-screen-look-themes cell_table yields {address, payload}
        // rows; unwrap the payload so theme fields read from it, not the row
        // wrapper (mirrors the chooser's readThemeRowPayload + the desktop
        // reader). Without this, candidate.id is always undefined and no look
        // ever matches, so the palette stays default.
        var row = objectOrEmpty(themes[t]);
        var candidate =
          row.payload &&
          typeof row.payload === "object" &&
          !Array.isArray(row.payload)
            ? row.payload
            : row;
        if (
          readString(candidate.id) === currentName ||
          readString(candidate.name) === currentName
        ) {
          theme = candidate;
          break;
        }
      }
      var map = resolve(theme) || {};
    } else {
      map = {};
    }
    function pick(variable, fallback) {
      var value = readString(map[variable]);
      return value || fallback;
    }
    return {
      background: pick("--bg-primary", "#111827"),
      surface: pick("--bg-surface", "#1f2937"),
      headerBg: pick("--glass-bg-primary", "rgba(31, 41, 55, 0.88)"),
      surfaceRaised: pick("--glass-bg-subtle", "rgba(56, 189, 248, 0.08)"),
      glassHover: pick("--glass-bg-hover", "rgba(56, 189, 248, 0.14)"),
      glassActive: pick("--glass-bg-active", "rgba(56, 189, 248, 0.22)"),
      popoverBg: pick("--glass-bg-popover", "rgba(31, 41, 55, 0.96)"),
      overlayBg: pick("--glass-overlay-background", "rgba(17, 24, 39, 0.72)"),
      borderPrimary: pick("--border-primary", "rgba(56, 189, 248, 0.24)"),
      borderSecondary: pick("--border-secondary", "rgba(56, 189, 248, 0.36)"),
      borderFocus: pick("--border-focus", "rgba(56, 189, 248, 0.58)"),
      textPrimary: pick("--text-primary", "#f8fafc"),
      textStrong: pick("--text-strong", "rgba(248, 250, 252, 0.92)"),
      textSecondary: pick("--text-secondary", "rgba(248, 250, 252, 0.76)"),
      textTertiary: pick("--text-tertiary", "rgba(248, 250, 252, 0.62)"),
      textMuted: pick("--text-muted", "rgba(248, 250, 252, 0.44)"),
      accent: pick("--accent-primary", "#38bdf8"),
    };
  }

  function readNamedPackageInput(mount, packageName, inputName) {
    var responseText = mount.invoke(
      PACKAGE_INPUT_READ_OPERATION,
      JSON.stringify({ package_name: packageName, input_name: inputName }),
    );
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found !== false ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  // Tab icon names arrive as the package's icon vocabulary (lucide names in
  // placeable-surface records). The platform paints SF Symbols; this is the
  // package's own translation of its own data — not shell vocabulary.
  var ICON_NAMES = {
    Square: "square",
    MessageSquare: "message",
    Message: "message",
    Folder: "folder",
    FileText: "doc.text",
    Notebook: "book.closed",
    Mic: "mic",
    LayoutDashboard: "square.grid.2x2",
    Table: "tablecells",
    Film: "film",
    Image: "photo",
    Globe: "globe",
    Pencil: "pencil",
    Search: "magnifyingglass",
    Check: "checkmark",
    Palette: "paintpalette",
    Activity: "waveform.path.ecg",
    Settings: "gearshape",
    Calendar: "calendar",
    Users: "person.2",
    Bot: "sparkles",
  };

  function sfSymbol(name) {
    return ICON_NAMES[String(name || "Square")] || "square";
  }

  // Compact icon button for the container toolbar — 24x24 hit target matching
  // the canonical [split-h][split-v][pip][maximize][close] control row.
  function iconButton(symbolName, action, palette, options) {
    var opts = objectOrEmpty(options);
    return node(
      "box",
      {
        background: opts.active ? palette.glassActive : null,
        borderWidth: 0,
        cornerRadius: 6,
        padding: 5,
        fillWidth: false,
        press: action,
      },
      [
        icon(
          symbolName,
          12,
          opts.destructive
            ? palette.textSecondary
            : opts.active
              ? palette.textStrong
              : palette.textSecondary,
          "medium",
        ),
      ],
    );
  }

  // The canonical "Move to Pane" affordance, expressed for touch: the ACTIVE
  // tab shows a move glyph when other containers exist; pressing it moves the
  // tab to the next container in tiled order (cycling).

  // Tab pill matching the canonical design: icon + title + close glyph.
  // Active: glass-active fill, strong text. Inactive: transparent, secondary.
  function tabButton(key, state, tab, active, context, containerId) {
    var palette = context.palette;
    var closeAction =
      tab.closable !== false
        ? slotAction("closeTab", { tabId: tab.id })
        : null;
    return node(
      "box",
      {
        // Stable identity — drag sessions reference their source view across
        // snapshot replaces (see renderContainer).
        id: "tab-pill:" + tab.id,
        background: active ? palette.glassActive : null,
        borderWidth: 0,
        cornerRadius: 6,
        padding: 0,
        fillWidth: false,
        // Typed payload (reference: application/x-tab-id) — the drop handler
        // branches on kind, exactly like the web's MIME-type branching.
        dragPayload: JSON.stringify({ kind: "tab", id: tab.id }),
      },
      [
        node("stack", { axis: "horizontal", spacing: 4 }, [
          node(
            "box",
            {
              fillWidth: false,
              borderWidth: 0,
              padding: 6,
              press: slotAction("activateTab", { tabId: tab.id }),
            },
            [
              node("stack", { axis: "horizontal", spacing: 4 }, [
                tab.icon
                  ? icon(
                      sfSymbol(tab.icon),
                      10,
                      active ? palette.textStrong : palette.textMuted,
                      "regular",
                    )
                  : null,
                text(
                  tab.title || tab.id,
                  12,
                  active ? "medium" : "regular",
                  active ? palette.textPrimary : palette.textSecondary,
                  1,
                ),
              ].filter(Boolean)),
            ],
          ),
          closeAction
            ? node(
                "box",
                {
                  fillWidth: false,
                  cornerRadius: 4,
                  padding: 6,
                  press: closeAction,
                },
                [
                  icon(
                    "xmark",
                    12,
                    active ? palette.textSecondary : palette.textMuted,
                    "medium",
                  ),
                ],
              )
            : null,
        ].filter(Boolean)),
      ],
    );
  }

  // Scrollable tab strip with the + button inline at the end — the canonical
  // [tabs…][+] left side of the container header.
  function tabStrip(key, state, containerId, context) {
    var group = groupForContainer(state, containerId);
    var tabIds = group ? arrayOrEmpty(group.tabIds) : [];
    var addAction = slotAction("addTab", {
      containerId: containerId,
      tab: makeEmptyTab(),
    });
    var children = tabIds
      .map(function (tabId) {
        var tab = state.tabs[tabId];
        if (!tab) return null;
        return tabButton(
          key,
          state,
          tab,
          tabId === group.activeTabId,
          context,
          containerId,
        );
      })
      .filter(Boolean);
    children.push(
      node(
        "box",
        {
          borderWidth: 0,
          cornerRadius: 6,
          padding: 6,
          fillWidth: false,
          press: addAction,
        },
        [icon("plus", 12, context.palette.textSecondary, "medium")],
      ),
    );
    // Intrinsic width: the strip sizes to its tabs so the header spacer can
    // push the control icons to the far right (canonical layout). When tabs
    // overflow, the scroll compresses and scrolls.
    return node("scroll", { axis: "horizontal", spacing: 0, fillWidth: false }, [
      node("stack", { axis: "horizontal", spacing: 2, fillWidth: false }, children),
    ]);
  }

  function surfaceCard(key, state, containerId, surface, context) {
    var palette = context.palette;
    return node(
      "box",
      {
        background: palette.surfaceRaised,
        border: palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 12,
        padding: 12,
        spacing: 7,
        press: slotAction("addSurfaceTab", {
          containerId: containerId,
          tab: tabForSurface(surface),
        }),
      },
      [
        node("stack", { axis: "horizontal", spacing: 10 }, [
          icon(sfSymbol(surface.icon), 16, palette.accent, "medium"),
          node("stack", { axis: "vertical", spacing: 3 }, [
            text(surface.label, 13, "semibold", palette.textPrimary, 2),
          ]),
        ]),
      ],
    );
  }

  function surfaceGrid(key, state, containerId, context) {
    var palette = context.palette;
    var surfaces = context.surfaces;
    if (!surfaces.length) {
      return node(
        "box",
        {
          background: palette.surfaceRaised,
          border: palette.borderPrimary,
          borderWidth: 1,
          cornerRadius: 12,
          padding: 16,
        },
        [
          text(
            "No things can go on this screen yet.",
            13,
            "regular",
            palette.textSecondary,
          ),
        ],
      );
    }
    return node(
      "grid",
      { columns: 2, spacing: 8 },
      surfaces.slice(0, 48).map(function (surface) {
        return surfaceCard(key, state, containerId, surface, context);
      }),
    );
  }

  // Content area: full-bleed surface when tab has content, clean picker when empty.
  function activeBody(key, state, containerId, context) {
    var tab = activeTabForContainer(state, containerId);
    if (!tab || isEmptyTab(tab)) {
      return node(
        "scroll",
        { axis: "vertical", spacing: 10 },
        [
          node("box", { borderWidth: 0, padding: 8, spacing: 10 }, [
            surfaceGrid(key, state, containerId, context),
          ]),
        ],
      );
    }
    // Has a live surface — render it full-bleed, no decorative card wrapper.
    return node("screen-region", { region: regionForContainer(containerId), spacing: 0 }, []);
  }

  // Canonical control row: [split-h] [split-v] [pip] [maximize] [close].
  // Same icons and order as the original container header.
  function containerToolbar(key, state, containerId, context) {
    var palette = context.palette;
    var right = slotAction("splitContainer", {
      containerId: containerId,
      dir: "row",
      position: "after",
      initialTab: makeEmptyTab(),
    });
    var below = slotAction("splitContainer", {
      containerId: containerId,
      dir: "column",
      position: "after",
      initialTab: makeEmptyTab(),
    });
    var overlay = slotAction("toggleOverlay", { containerId: containerId }, true);
    var maximize = slotAction("toggleMaximize", { containerId: containerId });
    var close = slotAction("closeContainer", { containerId: containerId });
    var isMaximized = state.maximizedContainerId === containerId;
    var isInOverlay = arrayOrEmpty(overlayLayout(state).containers).some(
      function (entry) {
        return entry.containerId === containerId;
      },
    );
    // Phone-sized header: the MOVE GRIP and a "···" disclosure are the only
    // always-visible controls — tabs keep the room. Everything else lives in
    // the actions popover (split/pip/maximize/close), one tap away.
    //
    // Move grip (reference ContainerHeader DragHandle) — ALWAYS rendered:
    // - floating window (overlay/canvas): drag the grip moves the window
    //   (windowDragHandle routes the gesture to the window's position).
    // - tiled: the grip starts a CONTAINER drag (typed payload, reference
    //   application/x-container-id) — drop on another container's center
    //   swaps them, drop on an edge moves the container to that edge.
    var gripProps = {
      // Stable identity — the container drag session references this view.
      id: "move-grip:" + containerId,
      borderWidth: 0,
      cornerRadius: 6,
      padding: 8,
      fillWidth: false,
    };
    if (isInOverlay || state.surface === "canvas") {
      gripProps.windowDragHandle = true;
    } else {
      gripProps.dragPayload = JSON.stringify({
        kind: "container",
        id: containerId,
      });
    }
    var children = [
      node("box", gripProps, [
        icon("arrow.up.and.down.and.arrow.left.and.right", 13, palette.textSecondary, "medium"),
      ]),
      iconButton(
        "ellipsis",
        {
          operation: MOUNT_ACTION_OPERATION,
          payload: { kind: "toggle-actions", container_id: containerId },
        },
        palette,
        { active: actionsMenuContainerId === containerId },
      ),
    ];
    return node("stack", { axis: "horizontal", spacing: 2, fillWidth: false }, children);
  }

  // The "···" actions popover: split/pip/maximize/close as labeled rows.
  // Render-only ephemera (actionsMenuContainerId); every row forwards its
  // slot operation and closes the menu.
  function containerActionsMenu(key, state, containerId, context) {
    if (actionsMenuContainerId !== containerId) return null;
    var palette = context.palette;
    var isMaximized = state.maximizedContainerId === containerId;
    var isInOverlay = arrayOrEmpty(overlayLayout(state).containers).some(
      function (entry) {
        return entry.containerId === containerId;
      },
    );
    function menuRow(symbol, label, action, options) {
      var opts = options || {};
      return node(
        "box",
        {
          borderWidth: 0,
          cornerRadius: 8,
          padding: 9,
          fillWidth: true,
          press: {
            operations: [
              {
                operation: MOUNT_ACTION_OPERATION,
                payload: { kind: "toggle-actions", container_id: null },
              },
              action,
            ],
          },
        },
        [
          node("stack", { axis: "horizontal", spacing: 9 }, [
            icon(
              symbol,
              13,
              opts.destructive ? "rgba(248, 113, 113, 0.9)" : palette.textSecondary,
              "medium",
            ),
            text(
              label,
              13,
              "medium",
              opts.destructive ? "rgba(248, 113, 113, 0.9)" : palette.textPrimary,
              1,
            ),
          ]),
        ],
      );
    }
    var rows = [
      menuRow(
        "rectangle.split.2x1",
        "Split right",
        slotAction("splitContainer", {
          containerId: containerId,
          dir: "row",
          position: "after",
          initialTab: makeEmptyTab(),
        }),
      ),
      menuRow(
        "rectangle.split.1x2",
        "Split below",
        slotAction("splitContainer", {
          containerId: containerId,
          dir: "column",
          position: "after",
          initialTab: makeEmptyTab(),
        }),
      ),
      menuRow(
        "pip",
        isInOverlay ? "Leave picture in picture" : "Picture in picture",
        slotAction("toggleOverlay", { containerId: containerId }, true),
      ),
      menuRow(
        isMaximized
          ? "arrow.down.right.and.arrow.up.left"
          : "arrow.up.left.and.arrow.down.right",
        isMaximized ? "Restore size" : "Maximize",
        slotAction("toggleMaximize", { containerId: containerId }),
      ),
    ];
    if (countLeaves(tiledLayout(state).root) > 1 || isInOverlay) {
      rows.push(
        menuRow(
          "xmark",
          "Close container",
          slotAction("closeContainer", { containerId: containerId }),
          { destructive: true },
        ),
      );
    }
    // Whole-screen arrangement controls (formerly the chevron menu): the
    // surface toggle + saved layouts disclosure live here too - ONE menu.
    rows.push(
      menuRow(
        state.surface === "canvas" ? "square.grid.2x2" : "square.on.square",
        state.surface === "canvas" ? "Switch to tiles" : "Switch to canvas",
        slotAction(
          "setSurface",
          { surface: state.surface === "canvas" ? "grid" : "canvas" },
          state.surface !== "canvas",
        ),
      ),
    );
    rows.push(
      menuRow("square.stack.3d.up", "Layouts", {
        operation: MOUNT_ACTION_OPERATION,
        payload: { kind: "toggle-menu" },
      }),
    );
    return node(
      "box",
      {
        background: context.palette.popoverBg,
        border: context.palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 12,
        padding: 5,
        spacing: 2,
        fillWidth: false,
      },
      rows,
    );
  }

  function countLeaves(treeNode) {
    if (!treeNode) return 0;
    if (treeNode.kind === "leaf") return 1;
    return arrayOrEmpty(treeNode.children).reduce(function (sum, child) {
      return sum + countLeaves(child);
    }, 0);
  }

  function removeLeaf(treeNode, containerId) {
    if (!treeNode) return null;
    if (treeNode.kind === "leaf") {
      return treeNode.containerId === containerId ? null : treeNode;
    }
    var children = arrayOrEmpty(treeNode.children)
      .map(function (child) {
        return removeLeaf(child, containerId);
      })
      .filter(Boolean);
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    var count = children.length;
    return {
      kind: "split",
      dir: treeNode.dir,
      sizes: children.map(function () {
        return 1 / count;
      }),
      children: children,
    };
  }


  // Container: header row (tab strip + control icons) + full-bleed content.
  // The canonical layout: tabs left, controls right, content fills below.
  function renderContainer(key, state, containerId, context) {
    var palette = context.palette;
    return node(
      "box",
      {
        // Stable identity: drag sessions (tab pills, container grips) hold
        // references to their source views across snapshot replaces. An
        // identity-less node is destroyed+recreated every render — UIKit's
        // drag set-down animation then dereferences the dead source view
        // (EXC_BAD_ACCESS in DragAndDropBridge previewForCancelling).
        id: "container:" + containerId,
        background: palette.surface,
        border: palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 16,
        padding: 0,
        spacing: 0,
        fillHeight: true,
        // Reference ContainerDropDelegate port: the WHOLE container is the
        // drop target. The shell classifies the live drop location into
        // zones (48pt edge bands, 36pt tab-strip top inset — TAB_EDGE_PX /
        // tabStripHeight from the reference) and reports {payload, zone}.
        // Edge zone → splitContainerWithTab; center → moveTabToContainer.
        dropEdgeBand: 48,
        dropTopInset: 36,
        drop: {
          operation: MOUNT_ACTION_OPERATION,
          payload: {
            kind: "tab-drop",
            container_id: containerId,
            value: gestureValueMarker(),
          },
        },
        // Hover overlays are DATA: the shell renders the declared node for
        // the hovered zone locally — hover never round-trips (a snapshot
        // replace mid-drop-session destroys the target and the session
        // collapses). Reference visuals: EdgeOverlayView dashed strips +
        // CenterDropOverlayView highlight.
        dropOverlays: dropZoneOverlayNodes(context),
      },
      [
        node(
          "box",
          {
            background: palette.headerBg,
            border: null,
            borderWidth: 0,
            cornerRadius: 0,
            padding: 6,
            press: slotAction("focusContainer", { containerId: containerId }),
          },
          [
            // Reference header layout: the TAB STRIP scrolls (intrinsic
            // width), controls stay pinned right at full touch size. The
            // arrangement menu (Tiles/Canvas + saved layouts) lives in the
            // "..." menu - no separate chevron eating header space.
            node("stack", { axis: "horizontal", spacing: 6 }, [
              tabStrip(key, state, containerId, context),
              // Canonical header: tabs left, controls pinned right.
              node("spacer", {}, []),
              containerToolbar(key, state, containerId, context),
            ]),
          ],
        ),
        // Body + drop-zone overlays + actions popover share a zstack:
        // overlays PAINT OVER the body (reference ZStack in
        // ContainerHostView), never push it down. The "···" popover anchors
        // top-trailing, right under its button.
        node("zstack", { fillHeight: true }, [
          node("box", { borderWidth: 0, padding: 4, spacing: 0, fillHeight: true }, [
            activeBody(key, state, containerId, context),
          ]),
          // Outside-tap dismiss (reference ContainerHeader closeIfOutside): a
          // transparent fill BEHIND the popover. Tapping anywhere off the menu
          // rows closes it. Without this the "···" menu could only be dismissed
          // by re-tapping its button — the "stuck open" report.
          actionsMenuContainerId === containerId
            ? node(
                "box",
                {
                  borderWidth: 0,
                  fillWidth: true,
                  fillHeight: true,
                  press: {
                    operations: [
                      {
                        operation: MOUNT_ACTION_OPERATION,
                        payload: { kind: "toggle-actions", container_id: null },
                      },
                    ],
                  },
                },
                [],
              )
            : null,
          actionsMenuContainerId === containerId
            ? node(
                "box",
                { borderWidth: 0, padding: 6, fillWidth: true, align: "trailing" },
                [
                  node("stack", { axis: "horizontal", spacing: 0 }, [
                    node("spacer", {}, []),
                    containerActionsMenu(key, state, containerId, context),
                  ]),
                ],
              )
            : null,
        ]),
      ],
    );
  }

  // Reference EdgeOverlayView / CenterDropOverlayView as DECLARED data:
  // the shell renders the node for the hovered zone locally during the
  // drop session (dropOverlays prop). Zero hover round-trips.
  function dropZoneOverlayNodes(context) {
    var palette = context.palette;
    function edgeStrip(zoneName) {
      var horizontal = zoneName === "left" || zoneName === "right";
      var strip = node(
        "box",
        {
          background: "rgba(255, 255, 255, 0.05)",
          border: "rgba(255, 255, 255, 0.3)",
          borderWidth: 2,
          borderDash: [6, 4],
          cornerRadius: 8,
          padding: 0,
          hitTestable: false,
          width: horizontal ? 64 : undefined,
          height: horizontal ? undefined : 64,
          fillWidth: horizontal ? false : true,
          fillHeight: horizontal ? true : false,
          align: "center",
        },
        [text("+ new pane", 11, "medium", "rgba(255, 255, 255, 0.7)", 1)],
      );
      var leadingEdge = zoneName === "left" || zoneName === "top";
      return node(
        "box",
        { borderWidth: 0, padding: 8, spacing: 0, fillHeight: true, hitTestable: false },
        [
          node(
            "stack",
            { axis: horizontal ? "horizontal" : "vertical", spacing: 0, fillHeight: true },
            leadingEdge ? [strip, node("spacer", {}, [])] : [node("spacer", {}, []), strip],
          ),
        ],
      );
    }
    return {
      center: node(
        "box",
        {
          background: "rgba(255, 255, 255, 0.08)",
          border: palette.borderSecondary,
          borderWidth: 2,
          cornerRadius: 8,
          padding: 0,
          fillHeight: true,
          hitTestable: false,
          align: "center",
        },
        [text("Move tab here", 12, "medium", "rgba(255, 255, 255, 0.6)", 1)],
      ),
      left: edgeStrip("left"),
      right: edgeStrip("right"),
      top: edgeStrip("top"),
      bottom: edgeStrip("bottom"),
    };
  }

  // Frame-edge overlays for the tiled gutter (24pt strips at the screen
  // edges) — declared data, shell-rendered on hover. No center overlay:
  // frame center is not an action.
  function frameEdgeOverlayNodes() {
    function frameStrip(zoneName) {
      var horizontal = zoneName === "left" || zoneName === "right";
      var strip = node(
        "box",
        {
          background: "rgba(255, 255, 255, 0.05)",
          border: "rgba(255, 255, 255, 0.3)",
          borderWidth: 2,
          borderDash: [6, 4],
          cornerRadius: 8,
          padding: 0,
          hitTestable: false,
          width: horizontal ? 24 : undefined,
          height: horizontal ? undefined : 24,
          fillWidth: horizontal ? false : true,
          fillHeight: horizontal ? true : false,
        },
        [],
      );
      var leadingEdge = zoneName === "left" || zoneName === "top";
      return node(
        "box",
        { borderWidth: 0, padding: 2, spacing: 0, fillHeight: true, hitTestable: false },
        [
          node(
            "stack",
            { axis: horizontal ? "horizontal" : "vertical", spacing: 0, fillHeight: true },
            leadingEdge ? [strip, node("spacer", {}, [])] : [node("spacer", {}, []), strip],
          ),
        ],
      );
    }
    return {
      left: frameStrip("left"),
      right: frameStrip("right"),
      top: frameStrip("top"),
      bottom: frameStrip("bottom"),
    };
  }

  // Recursive weighted-split tree — the canonical tiled surface. Every split
  // renders as a weighted-split atom with live drag-resize rails; the resize
  // gesture writes the final fractions straight into saved layout state via
  // the screen.gesture.value marker.
  function renderSplitTree(key, state, treeNode, path, context) {
    if (!treeNode) return null;
    if (treeNode.kind === "leaf") {
      return renderContainer(key, state, treeNode.containerId, context);
    }
    var children = arrayOrEmpty(treeNode.children);
    var sizes = arrayOrEmpty(treeNode.sizes);
    if (children.length !== sizes.length || !children.length) {
      sizes = children.map(function () {
        return 1 / Math.max(1, children.length);
      });
    }
    return node(
      "weighted-split",
      {
        axis: treeNode.dir === "column" ? "vertical" : "horizontal",
        sizes: sizes,
        resizable: true,
        minFraction: 0.1,
        railColor: context.palette.borderSecondary,
        minHeight: 200,
        resize: slotAction("resizeSplit", {
          sizes: gestureValueMarker(),
          path: path,
        }),
      },
      children.map(function (child, index) {
        return renderSplitTree(key, state, child, path.concat([index]), context);
      }),
    );
  }

  // Canvas surface: float-layer with the saved camera. Pan/zoom persists the
  // camera; each container window is draggable and resizable.
  function renderCanvasSurface(key, state, context) {
    var floating = floatingLayout(state);
    var withWindows = state;
    containerIdsForState(state).forEach(function (containerId, index) {
      withWindows = ensureFloatingWindow(withWindows, containerId, index);
    });
    var windows = arrayOrEmpty(floatingLayout(withWindows).containers);
    return node(
      "float-layer",
      {
        background: context.palette.overlayBg,
        minHeight: 620,
        camera: floating.camera,
        cameraChange: slotAction("setCamera", gestureValueMarker()),
      },
      windows.map(function (window) {
        var gestureAction = slotAction("updateFloatingRect", {
          containerId: window.containerId,
          rect: gestureValueMarker(),
        });
        return node(
          "box",
          {
            id: "canvas-window:" + window.containerId,
            background: context.palette.surface,
            border:
              state.focusedContainerId === window.containerId
                ? "rgba(52, 211, 153, 0.6)"
                : context.palette.borderPrimary,
            borderWidth: 1,
            cornerRadius: 12,
            padding: 0,
            frame: { x: window.x, y: window.y, w: window.w, h: window.h },
            z: readNumber(window.z, 1),
            drag: gestureAction,
            resize: gestureAction,
          },
          [renderContainer(key, withWindows, window.containerId, context)],
        );
      }),
    );
  }

  // PiP overlay surface: always-on float layer above the active surface with
  // draggable/resizable windows — the canonical picture-in-picture behavior.
  function renderOverlaySurface(key, state, context) {
    var overlay = overlayLayout(state);
    var windows = arrayOrEmpty(overlay.containers).filter(function (entry) {
      return state.containers[entry.containerId];
    });
    if (!windows.length) return null;
    return node(
      "float-layer",
      { fillHeight: true },
      windows.map(function (window) {
        // The slot's overlay contract (same as React): position commits via
        // moveOverlay{xy}, size via resizeOverlay{size}. The gesture geometry
        // ({x,y,w,h}) substitutes into both; each op reads its own fields
        // (the slot tolerates the extra ones — verified against the WASM).
        var dragAction = slotAction("moveOverlay", {
          containerId: window.containerId,
          xy: gestureValueMarker(),
        });
        var resizeAction = slotActions([
          slotAction("moveOverlay", {
            containerId: window.containerId,
            xy: gestureValueMarker(),
          }),
          slotAction("resizeOverlay", {
            containerId: window.containerId,
            size: gestureValueMarker(),
          }),
        ]);
        return node(
          "box",
          {
            id: "overlay-window:" + window.containerId,
            background: context.palette.popoverBg,
            border: context.palette.borderSecondary,
            borderWidth: 1,
            cornerRadius: 12,
            padding: 0,
            frame: { x: window.x, y: window.y, w: window.w, h: window.h },
            z: 100 + readNumber(window.z, 1),
            drag: dragAction,
            resize: resizeAction,
          },
          [renderContainer(key, state, window.containerId, context)],
        );
      }),
    );
  }

  function textButton(label, action, palette, accent) {
    return node(
      "box",
      {
        background: accent ? palette.glassActive : palette.surfaceRaised,
        border: accent ? palette.borderSecondary : palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 10,
        padding: 9,
        fillWidth: false,
        press: action,
      },
      [
        text(
          label,
          12,
          "semibold",
          accent ? palette.textStrong : palette.textSecondary,
          1,
        ),
      ],
    );
  }

  function savedLayoutControls(key, state, context) {
    var palette = context.palette;
    var presetNodes = context.presets.slice(0, 12).map(function (preset) {
      var loadState = normalizeLayoutState(preset.layout);
      return node(
        "box",
        {
          background: palette.surfaceRaised,
          border: palette.borderPrimary,
          borderWidth: 1,
          cornerRadius: 12,
          padding: 12,
          spacing: 8,
        },
        [
          text(preset.name, 13, "semibold", palette.textPrimary, 1),
          node("stack", { axis: "horizontal", spacing: 8 }, [
            textButton(
              "Load",
              // applyLayoutState is the ONE non-slot transition in the React
              // contract too: the preset state IS the next state (the slot
              // normalized it when it was saved). Full-state replacement.
              {
                operation: MOUNT_ACTION_OPERATION,
                payload: { kind: "layout-state", state: loadState },
              },
              palette,
              true,
            ),
            textButton(
              "Archive",
              {
                operations: [
                  archivePresetOperation(preset),
                  publishLayoutPresetsOperation(),
                  reloadOperation(),
                ],
              },
              palette,
            ),
          ]),
          node(
            "text-input",
            {
              value: preset.name,
              placeholder: "Rename saved layout",
              label: "Rename saved layout",
              submit: savePresetAction(
                preset.id,
                preset.layout,
                inputValueMarker(),
                preset,
              ),
            },
            [],
          ),
        ],
      );
    });
    return node(
      "box",
      {
        background: palette.popoverBg,
        border: palette.borderPrimary,
        borderWidth: 1,
        cornerRadius: 14,
        padding: 14,
        spacing: 12,
      },
      [
        text("Saved layouts", 14, "semibold", palette.textPrimary, 1),
        node(
          "text-input",
          {
            value: "Mobile layout",
            placeholder: "Saved layout name",
            label: "Save current layout as",
            submit: savePresetAction(
              makeId("layout", "mobile-layout"),
              state,
              inputValueMarker(),
              null,
            ),
          },
          [],
        ),
        node("stack", { axis: "vertical", spacing: 10 }, presetNodes),
      ],
    );
  }

  // Arrangement menu: surface-mode toggle (Tiles/Canvas) + saved layouts —
  // the whole-screen parts of the canonical arrangement menu. Disclosed by
  // the chevron next to the tab strip, hidden by default so the screen is
  // the containers, not chrome.
  function arrangementPopover(key, state, context) {
    var bar = arrangementBar(key, state, context);
    if (!bar) return null;
    return node("zstack", { fillHeight: true }, [
      // Outside-tap dismiss (mirrors the "···" actions menu closeIfOutside): a
      // transparent full-screen fill BEHIND the popover. Tapping anywhere off
      // the menu closes it. Without this the Layouts popover had NO way to be
      // dismissed (no chevron, no backdrop) — the "stuck open" report.
      node(
        "box",
        {
          borderWidth: 0,
          fillWidth: true,
          fillHeight: true,
          press: {
            operations: [
              {
                operation: MOUNT_ACTION_OPERATION,
                payload: { kind: "toggle-menu" },
              },
            ],
          },
        },
        [],
      ),
      node(
        "box",
        { borderWidth: 0, padding: 8, spacing: 0, fillWidth: true },
        [
          // Fixed offset below the header row — a flexible spacer would shove
          // the popover to the bottom of the screen.
          node("divider", { height: 44 }, []),
          node(
            "box",
            {
              background: context.palette.popoverBg,
              border: context.palette.borderPrimary,
              borderWidth: 1,
              cornerRadius: 14,
              padding: 0,
              spacing: 0,
            },
            [node("scroll", { axis: "vertical", spacing: 0, maxHeight: 460 }, [bar])],
          ),
        ],
      ),
    ]);
  }

  function arrangementBar(key, state, context) {
    if (arrangementMenuOpen !== true) return null;
    var palette = context.palette;
    var isCanvas = state.surface === "canvas";
    var children = [
      node("stack", { axis: "horizontal", spacing: 6 }, [
        textButton(
          "Tiles",
          slotAction("setSurface", { surface: "grid" }),
          palette,
          !isCanvas,
        ),
        textButton(
          "Canvas",
          // React contract: canvas needs the viewport to seed window frames.
          slotAction("setSurface", { surface: "canvas" }, true),
          palette,
          isCanvas,
        ),
      ]),
    ];
    if (state.maximizedContainerId === null)
      children.push(savedLayoutControls(key, state, context));
    return node("box", { borderWidth: 0, padding: 10, spacing: 10 }, children);
  }

  function buildSnapshot(key, state, context) {
    var palette = context.palette;
    var maximizedId =
      state.maximizedContainerId &&
      state.containers[state.maximizedContainerId]
        ? state.maximizedContainerId
        : null;

    var mainSurface;
    if (maximizedId) {
      mainSurface = node(
        "box",
        { borderWidth: 0, padding: 10, spacing: 0, fillHeight: true },
        [renderContainer(key, state, maximizedId, context)],
      );
    } else if (state.surface === "canvas") {
      mainSurface = renderCanvasSurface(key, state, context);
    } else {
      // Frame-edge drop zones (reference GutterTargets frame strips): the
      // tiled frame's outer padding gutter accepts drops on all four edges —
      // dropping wraps the ENTIRE root in a new split (splitRootWithTab /
      // moveContainerToRoot). The frame box itself is the drop target with
      // edge-band-only classification (no center action): its 10pt padding
      // ring is the catch area outside the containers, matching the web's
      // FRAME_EDGE_PX strips living in the arranger's padding.
      mainSurface = node(
        "zstack",
        { fillHeight: true },
        [
          node(
            "box",
            {
              borderWidth: 0,
              padding: 10,
              spacing: 0,
              fillHeight: true,
              dropEdgeBand: 10,
              drop: {
                operation: MOUNT_ACTION_OPERATION,
                payload: { kind: "frame-drop", value: gestureValueMarker() },
              },
              dropOverlays: frameEdgeOverlayNodes(),
            },
            [renderSplitTree(key, state, tiledLayout(state).root, [], context)],
          ),
        ],
      );
    }

    var overlaySurface = maximizedId
      ? null
      : renderOverlaySurface(key, state, context);

    return {
      schema: "bitfield.native.view.snapshot",
      lifecycle_key: key,
      root: node(
        "screen",
        {
          background: palette.background,
          cornerRadius: 0,
          padding: 0,
          spacing: 0,
        },
        [
          node("zstack", { fillHeight: true }, [
            mainSurface,
            overlaySurface,
            arrangementPopover(key, state, context),
          ].filter(Boolean)),
        ].filter(Boolean),
      ),
    };
  }

  var mountedThingSignatures = {};

  function mountActiveThings(mount, state, key, context) {
    var operations = mountOperationsForState(state, context.records, mount);
    for (var i = 0; i < operations.length; i += 1) {
      var operation = operations[i];
      var lifecycle = operation.payload.lifecycle_key;
      // Identity signature ONLY: which thing runs in this slot. The
      // payload's input (focused/maximized flags) changes on every
      // transition — including it re-booted every placed surface per tap
      // once two surfaces existed (each boot serializes on the engine
      // gate = the freeze-after-second-place).
      var signature =
        operation.operation === SNAPSHOT_DISPOSE_OPERATION
          ? null
          : JSON.stringify({
              thing: operation.payload.thing,
              region: operation.payload.region,
            });
      if (mountedThingSignatures[lifecycle] === signature) continue;
      if (signature === null && !(lifecycle in mountedThingSignatures))
        continue;
      mountedThingSignatures[lifecycle] = signature;
      mount.invoke(operation.operation, JSON.stringify(operation.payload));
    }
  }

  function loadContext(mount) {
    var records = readPackageInputArray(mount, "published-records");
    var surfaceRecords = readPackageInputRows(mount, "placeable-surfaces");
    var canonicalLayoutState = decodeLayoutState(
      readPackageInput(mount, "layout-state"),
    );
    return {
      records: records,
      palette: resolvePalette(mount),
      layoutState: canonicalLayoutState,
      surfaces: loadPlaceableSurfaces(surfaceRecords),
      presets: decodeLayoutPresets(
        readPackageInputRows(mount, "layout-presets"),
      ),
    };
  }

  // Render-only ephemera (never persisted, never sent to the slot):
  // the drag-hover drop-zone highlight + zone, the frame-edge hover, and
  // the arrangement-menu disclosure.
  var arrangementMenuOpen = false;
  // Which container's "···" actions popover is open (one at a time).
  var actionsMenuContainerId = null;

  // Typed drag payloads — iOS port of the web's MIME-type branching
  // (application/x-tab-id vs application/x-container-id). The drag source
  // stows {kind, id} as JSON; plain strings stay tab ids for resilience.
  function parseDragPayload(value) {
    var raw = readString(value);
    if (!raw) return null;
    if (raw.charAt(0) === "{") {
      try {
        var parsed = JSON.parse(raw);
        var id = readString(parsed.id);
        if (id) {
          return {
            kind: readString(parsed.kind) === "container" ? "container" : "tab",
            id: id,
          };
        }
      } catch (error) {
        // fall through to the plain-string case
      }
    }
    return { kind: "tab", id: raw };
  }

  globalThis.bitfieldMount = function bitfieldMount(record, mount) {
    var key = lifecycleKey(record);
    ownerReloadKeyForChildren = key;
    // iOS has no workspace-loaded trigger to materialize the placeable-surfaces
    // aggregate the picker reads. Materialize it once, synchronously, on the
    // foreground lane BEFORE loadContext reads it, so the first render has surfaces.
    var publishSurfaces = publishPlaceableSurfacesOperation();
    mount.invoke(publishSurfaces.operation, JSON.stringify(publishSurfaces.payload));
    var context = loadContext(mount);
    var state = context.layoutState;
    var snapshot = buildSnapshot(key, state, context);
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    mountActiveThings(mount, state, key, context);

    // Warm the brain at mount time: the FIRST ask to the slot pays the
    // engine/WASM activation cost. Paying it here, on the ordered background
    // lane, means the first user interaction gets a warm slot instead of
    // blocking the live context for the entire activation. The reply is
    // discarded — focusContainer on the already-focused container is a no-op
    // transition.
    mount.invoke(
      TARGET_INVOKE_BACKGROUND_OPERATION,
      JSON.stringify({
        target: SLOT_TARGET,
        payload: {
          state: state,
          operation: "focusContainer",
          payload: { containerId: state.focusedContainerId },
        },
      }),
    );

    // Live action path (screen.mount.action): render the next state from
    // memory IMMEDIATELY, then persist. Interaction latency = one JS call +
    // one snapshot replace; the save/publish round-trip happens after the
    // user already sees the result. This is the same optimistic order the
    // web shell gets from React state + background writes.
    // Stale-snapshot guard: rendered actions carry the revision of the
    // snapshot they came from. A payload from an OLDER snapshot is dropped —
    // a press payload (full pre-resize state) landing right after a rail
    // release was re-applying the old split sizes ("resize then it resets").
    // Render the given state, mount/unmount active things, and persist —
    // the ONLY place state is accepted. The state came from the slot.
    function commitState(nextState) {
      state = normalizeLayoutState(nextState);
      snapshot = buildSnapshot(key, state, context);
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
      mountActiveThings(mount, state, key, context);
      // Persistence rides the background lane: ordered, off the interaction
      // path. The screen above already shows the new state; this direct
      // whole-payload write makes it durable for the next cold open.
      // Latest-wins coalescing (coalesce_key): a burst of transitions costs
      // ONE save of the final state — superseded queued writes are dropped by
      // the shell. Each save writes the WHOLE layout state, so
      // intermediate writes carry no information the final one lacks.
      var saveRequest = saveLayoutStateOperation(state).payload;
      saveRequest.coalesce_key = "screen-arrangement:save-layout-state";
      mount.invoke(
        TARGET_INVOKE_BACKGROUND_OPERATION,
        JSON.stringify(saveRequest),
      );
    }

    function rerenderOnly() {
      snapshot = buildSnapshot(key, state, context);
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    }

    // Ask the brain. slot::screen-arrangement (the SAME Rust slot the React
    // arranger asks) computes every transition; the mount renders the reply.
    // Synchronous through the shell's live target invoke — one owner, no
    // second state machine, no divergence (SSOT).
    function askSlot(operation, args, viewport) {
      var request = { state: state, operation: operation, payload: args || {} };
      if (
        viewport &&
        typeof viewport.w === "number" &&
        typeof viewport.h === "number"
      ) {
        request.viewport = { w: viewport.w, h: viewport.h };
      }
      var replyText = mount.invoke(
        TARGET_INVOKE_OPERATION,
        JSON.stringify({ target: SLOT_TARGET, payload: request }),
      );
      var reply;
      try {
        reply = JSON.parse(replyText || "{}");
      } catch (error) {
        return null;
      }
      var replyState =
        objectOrEmpty(reply).state ||
        objectOrEmpty(objectOrEmpty(reply).payload).state;
      return replyState && typeof replyState === "object" ? replyState : null;
    }

    globalThis.bitfieldOnAction = function bitfieldOnAction(payloadText) {
      var payload;
      try {
        payload = JSON.parse(payloadText);
      } catch (error) {
        return;
      }
      if (!payload) return;
      if (payload.kind === "apply-look") {
        // A placed look chooser changed the current screen look. Recolor the
        // chrome instantly from the picked theme (optimistic — the durable
        // current-screen-look write rides the chooser's background lane), so
        // the whole app re-skins on the tap, not on the next interaction.
        context.palette = resolvePalette(mount, readString(payload.theme_id));
        rerenderOnly();
        return;
      }
      // Live palette: re-read the screen-look selection on every action so
      // choosing a look re-skins the chrome on the next interaction. The
      // chooser writes current-screen-look and self-materializes the read-model
      // (publish-screen-look inline); without this the palette would stay frozen
      // at mount. Matches the desktop arranger, where the palette is reactive
      // (one code path — L089). resolvePalette is a pure read with safe defaults.
      context.palette = resolvePalette(mount);
      // Reference drop semantics (SplitTreeArranger onDropCapture +
      // LayoutEngine handleDropTarget — all slot ops, zero local logic):
      //   tab + center  → moveTabToContainer
      //   tab + edge    → splitContainerWithTab (dir/position from edge)
      //   container + center → swapContainers
      //   container + edge   → moveContainerToEdge
      // The dragged payload is typed JSON ({kind, id}) — the iOS port of the
      // web's application/x-tab-id vs application/x-container-id branching.
      if (payload.kind === "tab-drop") {
        var dropValue = objectOrEmpty(payload.value);
        var dragged = parseDragPayload(dropValue.payload);
        var dropContainerId = readString(payload.container_id);
        if (!dragged || !dropContainerId) {
          rerenderOnly();
          return;
        }
        var dropZone = readString(dropValue.zone) || "center";
        var edgeDir =
          dropZone === "left" || dropZone === "right" ? "row" : "column";
        var edgePosition =
          dropZone === "left" || dropZone === "top" ? "before" : "after";
        var dropReply = null;
        if (dragged.kind === "container") {
          if (dragged.id === dropContainerId) {
            rerenderOnly();
            return;
          }
          dropReply =
            dropZone === "center"
              ? askSlot("swapContainers", { a: dragged.id, b: dropContainerId })
              : askSlot("moveContainerToEdge", {
                  sourceId: dragged.id,
                  targetId: dropContainerId,
                  dir: edgeDir,
                  position: edgePosition,
                });
        } else {
          dropReply =
            dropZone === "center"
              ? askSlot("moveTabToContainer", {
                  tabId: dragged.id,
                  targetContainerId: dropContainerId,
                })
              : askSlot("splitContainerWithTab", {
                  targetContainerId: dropContainerId,
                  dir: edgeDir,
                  position: edgePosition,
                  tabId: dragged.id,
                });
        }
        if (dropReply) commitState(dropReply);
        else rerenderOnly();
        return;
      }
      // Frame-edge drop (reference GutterTargets frame strips): wraps the
      // ENTIRE root in a new split at the screen edge.
      if (payload.kind === "frame-drop") {
        var frameValue = objectOrEmpty(payload.value);
        var frameDragged = parseDragPayload(frameValue.payload);
        var frameEdge = readString(frameValue.zone);
        // A center drop on the frame is not a frame-edge action — the inner
        // container targets own center drops.
        if (!frameDragged || !frameEdge || frameEdge === "center") {
          rerenderOnly();
          return;
        }
        var frameDir =
          frameEdge === "left" || frameEdge === "right" ? "row" : "column";
        var framePosition =
          frameEdge === "left" || frameEdge === "top" ? "before" : "after";
        var frameReply =
          frameDragged.kind === "container"
            ? askSlot("moveContainerToRoot", {
                containerId: frameDragged.id,
                dir: frameDir,
                position: framePosition,
              })
            : askSlot("splitRootWithTab", {
                dir: frameDir,
                position: framePosition,
                tabId: frameDragged.id,
              });
        if (frameReply) commitState(frameReply);
        else rerenderOnly();
        return;
      }
      if (payload.kind === "toggle-menu") {
        arrangementMenuOpen = arrangementMenuOpen !== true;
        rerenderOnly();
        return;
      }
      if (payload.kind === "toggle-actions") {
        var requested = readString(payload.container_id);
        actionsMenuContainerId =
          requested && actionsMenuContainerId !== requested ? requested : null;
        rerenderOnly();
        return;
      }
      // Every layout transition goes to the ONE owner.
      if (payload.kind === "slot-operation" && readString(payload.op)) {
        var replyState = askSlot(payload.op, payload.args, payload.viewport);
        if (replyState) commitState(replyState);
        return;
      }
      // Full-state replacement (initial publish/load paths only).
      if (payload.kind === "layout-state" && payload.state) {
        commitState(payload.state);
      }
    };

    return {
      dispose: function dispose() {
        if (globalThis.bitfieldOnAction) delete globalThis.bitfieldOnAction;
        mount.invoke(
          SNAPSHOT_DISPOSE_OPERATION,
          JSON.stringify({
            lifecycle_key: snapshot.lifecycle_key,
          }),
        );
        mountOperationsForState(state, context.records, mount).forEach(
          function (operation) {
            if (operation.operation === SNAPSHOT_DISPOSE_OPERATION) return;
            mount.invoke(
              SNAPSHOT_DISPOSE_OPERATION,
              JSON.stringify({
                lifecycle_key:
                  operation.payload.lifecycle_key ||
                  (operation.payload.thing &&
                    operation.payload.thing.lifecycle_key),
              }),
            );
          },
        );
      },
    };
  };
})();
