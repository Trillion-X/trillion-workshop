// Purpose: package-owned entry that puts screen-arrangement on a shell screen.
// Invariants: package-owned source only talks through the sealed screen host;
// screen output is emitted as generic shell operations, not returned view code.

(function () {
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SNAPSHOT_REPLACE_OPERATION = 'screen.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'screen.snapshot.dispose';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function lifecycleKey(record) {
    return record && typeof record.lifecycle_key === 'string'
      ? record.lifecycle_key
      : 'component:screen-arrangement';
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: Array.isArray(children) ? children : []
    };
  }

  function text(value, size, weight, color) {
    return node('text', {
      text: String(value || ''),
      size: size,
      weight: weight || 'regular',
      color: color || 'darkTextPrimary'
    });
  }

  function runtimeTarget(screen, target, payload) {
    var responseText = screen.invoke(TARGET_INVOKE_OPERATION, JSON.stringify({
      target: target,
      payload: payload
    }));
    if (!responseText) return {};
    return JSON.parse(responseText);
  }

  function readString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  function readFirstString(record, keys) {
    for (var i = 0; i < keys.length; i += 1) {
      var value = readString(record[keys[i]]);
      if (value) return value;
    }
    return null;
  }

  function readPlaceableSurface(item, index) {
    var payload = objectOrEmpty(item && item.payload);
    if (!payload.kind) payload = objectOrEmpty(item);
    if (payload.kind !== 'placeable-surface') return null;
    if (payload.disabled === true) return null;
    var materialTarget = readFirstString(payload, [
      'material_target',
      'surface_target',
      'address_to_ask',
      'address',
      'target'
    ]);
    if (!materialTarget) return null;
    return {
      id: readFirstString(payload, ['id', 'surface_id']) || readString(item && item.address) || ('surface-' + index),
      label: readFirstString(payload, ['label', 'title', 'name']) || materialTarget,
      materialTarget: materialTarget,
      icon: readFirstString(payload, ['icon']) || 'Square',
      badge: readFirstString(payload, ['badge']) || null,
      order: typeof payload.order === 'number' ? payload.order : index
    };
  }

  function compareSurfaces(left, right) {
    if (left.order !== right.order) return left.order - right.order;
    if (left.label < right.label) return -1;
    if (left.label > right.label) return 1;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  }

  function loadPlaceableSurfaces(screen) {
    try {
      var reply = runtimeTarget(screen, 'find-current-items', {
        operation: 'find-current-items',
        in: 'published-record',
        include: ['address', 'payload']
      });
      var items = Array.isArray(reply.items) ? reply.items : [];
      var surfaces = [];
      for (var i = 0; i < items.length; i += 1) {
        var surface = readPlaceableSurface(items[i], i);
        if (surface) surfaces.push(surface);
      }
      return surfaces.sort(compareSurfaces);
    } catch (error) {
      return [];
    }
  }

  function buildSelectedSurfaceSnapshot(key, surface) {
    return {
      schema: 'screen_snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 0,
        spacing: 0
      }, [
        node('box', {
          background: 'darkSurface',
          borderWidth: 0,
          cornerRadius: 0,
          padding: 24,
          spacing: 18
        }, [
          node('stack', { axis: 'horizontal', spacing: 10 }, [
            node('box', {
              background: 'darkSurfaceRaised',
              cornerRadius: 8,
              padding: 6,
              fillWidth: false
            }, [text('Surface', 12, 'semibold', 'darkTextPrimary')]),
            text('selected', 12, 'regular', 'darkTextSecondary')
          ]),
          node('divider', { color: 'darkBorder', height: 1 }),
          node('stack', { axis: 'vertical', spacing: 14 }, [
            text('CURRENT TAB', 10, 'bold', 'darkTextSecondary'),
            text(surface.label, 28, 'semibold', 'darkTextPrimary'),
            text(surface.materialTarget, 12, 'regular', 'darkTextSecondary'),
            node('box', {
              background: 'darkSurfaceRaised',
              border: 'darkBorder',
              borderWidth: 1,
              cornerRadius: 16,
              padding: 16,
              spacing: 8
            }, [
              text('Placed in current tab', 15, 'semibold', 'darkTextPrimary'),
              text('This screen snapshot now points at the selected surface target. The shell did not know this package; it only executed package-owned screen bytes.', 12, 'regular', 'darkTextSecondary')
            ])
          ])
        ])
      ])
    };
  }

  function surfaceCard(surface, key) {
    return node('box', {
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 13,
      spacing: 8,
      press: {
        operations: [
          {
            operation: SNAPSHOT_REPLACE_OPERATION,
            payload: buildSelectedSurfaceSnapshot(key, surface)
          }
        ]
      }
    }, [
      node('stack', { axis: 'horizontal', spacing: 10 }, [
        node('box', {
          background: 'darkSurface',
          border: 'darkBorder',
          borderWidth: 1,
          cornerRadius: 12,
          padding: 8,
          fillWidth: false
        }, [
          text(surface.icon.slice(0, 2).toUpperCase(), 11, 'bold', 'accent')
        ]),
        node('stack', { axis: 'vertical', spacing: 3 }, [
          text(surface.label, 13, 'semibold', 'darkTextPrimary'),
          text('Place in current tab', 11, 'regular', 'darkTextSecondary')
        ])
      ])
    ]);
  }

  function buildSurfaceGrid(surfaces, key) {
    if (surfaces.length === 0) {
      return node('box', {
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 16,
        padding: 18
      }, [
        text('No placeable surfaces are published yet.', 13, 'regular', 'darkTextSecondary')
      ]);
    }

    var cards = [];
    for (var i = 0; i < surfaces.length && i < 48; i += 1) {
      cards.push(surfaceCard(surfaces[i], key));
    }
    return node('grid', { columns: 2, spacing: 10 }, cards);
  }

  function buildSnapshot(record, screen) {
    var surfaces = loadPlaceableSurfaces(screen);
    var key = lifecycleKey(record);
    return {
      schema: 'screen_snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 0,
        spacing: 0
      }, [
        node('box', {
          background: 'darkSurface',
          borderWidth: 0,
          cornerRadius: 0,
          padding: 24,
          spacing: 12
        }, [
          node('stack', { axis: 'horizontal', spacing: 10 }, [
            node('box', {
              background: 'darkSurfaceRaised',
              cornerRadius: 8,
              padding: 6,
              fillWidth: false
            }, [text('Surface', 12, 'semibold', 'darkTextPrimary')]),
            text('+', 17, 'regular', 'darkTextSecondary')
          ]),
          node('divider', { color: 'darkBorder', height: 1 }),
          node('stack', { axis: 'vertical', spacing: 12 }, [
            text('EMPTY TAB', 10, 'bold', 'darkTextSecondary'),
            text('Select the thing you want in this tab', 24, 'semibold', 'darkTextPrimary'),
            text('Pick any published placeable surface. This tab will become that surface without screen-arrangement knowing what package owns it.', 13, 'regular', 'darkTextSecondary'),
            node('box', {
              background: 'darkSurfaceRaised',
              border: 'darkBorder',
              borderWidth: 1,
              cornerRadius: 14,
              padding: 12
            }, [text('Search surfaces', 13, 'regular', 'darkTextSecondary')]),
            buildSurfaceGrid(surfaces, key)
          ])
        ])
      ])
    };
  }

  globalThis.putThingOnScreen = function putThingOnScreen(record, screen) {
    var snapshot = buildSnapshot(record, screen);
    screen.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));

    return {
      dispose: function dispose() {
        screen.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({
          lifecycle_key: snapshot.lifecycle_key
        }));
      }
    };
  };
}());
