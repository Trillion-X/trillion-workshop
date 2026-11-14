// Purpose: JavaScriptCore realization entry for service-connections.
// Invariants: no web framework, no DOM, no iOS-only schema. The mount reads the
// same package inputs as the browser surface and emits sealed native screen ops.

(function () {
  var PACKAGE_NAME = 'service-connections';
  var PACKAGE_INPUT_READ_OPERATION = 'package.input.read';
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var TARGET_INVOKE_BACKGROUND_OPERATION = 'runtime.target.invoke.background';
  var MOUNT_ACTION_OPERATION = 'screen.mount.action';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var CONNECT_TARGET = 'package::service-connections::target::connect-service';
  var DISCONNECT_TARGET = 'package::service-connections::target::disconnect-service';
  var PUBLISH_TARGET = 'package::service-connections::target::publish-service-connections';
  var SHARED_CONTRACT_SOURCE_PATHS = [
    'read-data/read-service-connection-readiness-view.ts',
    'do-work/connect-service.ts',
    'do-work/disconnect-service.ts',
    'do-work/workflow-actions.ts'
  ];

  var FALLBACK_FIELD = {
    id: 'credential',
    label: 'API key or token',
    required: true,
    secret: true,
    multiline: false,
    placeholder: 'Paste the key or token from this service',
    help: 'Most services call this an API key, access token, or secret key.',
    autocomplete: 'off',
    guideUrl: '',
    guideSteps: []
  };

  var STATE_DESCRIPTORS = [
    {
      id: 'pending',
      when: { isPending: true },
      label: 'Pending',
      badgeTone: 'neutral',
      group: 'available',
      actions: [{ label: 'Connect', intent: 'open', primary: true }]
    },
    {
      id: 'error',
      when: { canRetry: true },
      label: 'Retry',
      badgeTone: 'error',
      group: 'available',
      actions: [{ label: 'Retry', intent: 'open', primary: true }]
    },
    {
      id: 'connected',
      when: { canSend: true },
      label: 'Connected',
      badgeTone: 'success',
      group: 'connected',
      actions: [
        { label: 'Add account', intent: 'open', primary: false },
        { label: 'Disconnect', intent: 'disconnect', primary: false }
      ]
    },
    {
      id: 'disconnected',
      when: {},
      label: 'Connect',
      badgeTone: 'neutral',
      group: 'available',
      actions: [{ label: 'Connect', intent: 'open', primary: true }]
    }
  ];

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function arrayOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : (fallback || '');
  }

  function readBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true';
    return false;
  }

  function firstDefined(primary, secondary) {
    return primary === undefined || primary === null ? secondary : primary;
  }

  function readArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      try {
        var parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }
    return [];
  }

  function node(kind, props, children, id) {
    var built = {
      kind: kind,
      props: objectOrEmpty(props),
      children: arrayOrEmpty(children).filter(Boolean)
    };
    if (id) built.id = id;
    return built;
  }

  function text(value, size, weight, color, lineLimit) {
    var props = {
      text: String(value || ''),
      size: size,
      weight: weight || 'regular',
      color: color || 'darkTextPrimary'
    };
    if (lineLimit) props.lineLimit = lineLimit;
    return node('text', props, []);
  }

  function box(props, children, id) {
    return node('box', props, children, id);
  }

  function stack(axis, spacing, children, props) {
    var merged = objectOrEmpty(props);
    merged.axis = axis;
    merged.spacing = spacing;
    return node('stack', merged, children);
  }

  function button(label, action, primary) {
    return box({
      background: primary ? '#12315a' : 'darkSurfaceRaised',
      border: primary ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      press: action
    }, [text(label, 12, 'semibold', primary ? 'accent' : 'darkTextPrimary', 1)]);
  }

  function badge(label, tone) {
    return box({
      background: tone === 'success' ? '#10351f' : tone === 'error' ? '#3a1717' : 'darkSurfaceRaised',
      border: tone === 'success' ? '#2aa15f' : tone === 'error' ? '#cc4b4b' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 999,
      padding: 7,
      fillWidth: false
    }, [text(label, 11, 'semibold', tone === 'success' ? '#6fdc99' : tone === 'error' ? '#ff8f8f' : 'darkTextSecondary', 1)]);
  }

  function mark(row) {
    var initials = row.serviceName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (part) { return part.charAt(0).toUpperCase(); })
      .join('') || 'S';
    return box({
      background: row.logoUrl ? 'darkSurfaceRaised' : '#12315a',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 12,
      padding: 9,
      fillWidth: false,
      image: row.logoUrl || ''
    }, [text(initials, 12, 'bold', row.logoUrl ? 'darkTextSecondary' : 'accent', 1)]);
  }

  function lifecycleKey(record) {
    return readString(objectOrEmpty(record).lifecycle_key, 'component:service-connections:jscore');
  }

  function readPackageInput(mount, inputName) {
    var responseText = mount.invoke(PACKAGE_INPUT_READ_OPERATION, JSON.stringify({
      package_name: PACKAGE_NAME,
      input_name: inputName
    }));
    if (!responseText) return null;
    try {
      var reply = JSON.parse(responseText);
      return reply && reply.found !== false ? reply.value : null;
    } catch (error) {
      return null;
    }
  }

  function normalizeField(value) {
    var record = objectOrEmpty(value);
    var id = readString(record.id);
    if (!id) return null;
    return {
      id: id,
      label: readString(record.label, id),
      required: typeof record.required === 'boolean' ? record.required : true,
      secret: typeof record.secret === 'boolean' ? record.secret : true,
      multiline: typeof record.multiline === 'boolean' ? record.multiline : false,
      placeholder: readString(record.placeholder),
      help: readString(record.help),
      autocomplete: readString(record.autocomplete, 'off'),
      guideUrl: readString(record.guideUrl),
      guideSteps: readArray(record.guideSteps).filter(function (step) { return typeof step === 'string' && step.length > 0; })
    };
  }

  function normalizeEnvironment(value) {
    var record = objectOrEmpty(value);
    var id = readString(record.id);
    var baseAddresses = objectOrEmpty(record.baseAddresses);
    if (!id || Object.keys(baseAddresses).length === 0) return null;
    return {
      id: id,
      label: readString(record.label, id),
      default: record.default === true,
      baseAddresses: baseAddresses
    };
  }

  function normalizeVerifyRequest(value) {
    var record = objectOrEmpty(value);
    if (!record.url) return null;
    return {
      url: record.url,
      method: readString(record.method, 'GET'),
      headers: objectOrEmpty(record.headers),
      body: readString(record.body),
      injections: readArray(record.credential_injections).map(function (entry) {
        var injection = objectOrEmpty(entry);
        var placement = objectOrEmpty(injection.placement);
        return {
          fieldId: readString(injection.field_id),
          placement: {
            kind: readString(placement.kind),
            name: readString(placement.name),
            prefix: readString(placement.prefix),
            suffix: readString(placement.suffix)
          }
        };
      }).filter(function (entry) { return entry.fieldId && entry.placement.kind && entry.placement.name; }),
      timeoutMs: typeof record.timeout_ms === 'number' ? record.timeout_ms : 15000
    };
  }

  function normalizeConfig(value) {
    var record = objectOrEmpty(value);
    var vendor = readString(record.vendor);
    var name = readString(record.name);
    if (!vendor || !name) return null;
    var fields = readArray(record.credentialFields).map(normalizeField).filter(Boolean);
    var environments = readArray(record.environments).map(normalizeEnvironment).filter(Boolean);
    return {
      vendor: vendor,
      name: name,
      instructions: readString(record.instructions),
      defaultScopes: readArray(record.defaultScopes).filter(function (item) { return typeof item === 'string'; }),
      credentialFields: fields.length ? fields : [FALLBACK_FIELD],
      helperLinks: readArray(record.helperLinks),
      logoUrl: readString(record.logoUrl),
      category: readString(record.category),
      environments: environments,
      verifyRequest: normalizeVerifyRequest(record.verifyRequest)
    };
  }

  // The catalog is derived LIVE from the `published-records` projection: an
  // array of { address, payload } rows. A provider self-describes via a
  // credentialFields array on its payload (matching the browser reader); every
  // other published record is skipped. No regenerated cell_table.
  function normalizeConfigRows(raw) {
    var rows = arrayOrEmpty(raw);
    var seen = {};
    var configs = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = objectOrEmpty(rows[i]);
      var payload = objectOrEmpty(row.payload);
      if (!Array.isArray(payload.credentialFields)) continue;
      var config = normalizeConfig(payload);
      if (!config || seen[config.vendor]) continue;
      seen[config.vendor] = true;
      configs.push(config);
    }
    configs.sort(function (a, b) {
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    return configs;
  }

  function normalizeConnection(value) {
    var record = objectOrEmpty(value);
    var id = readString(record.id);
    var serviceName = readString(record.serviceName);
    var serviceVendor = readString(record.serviceVendor);
    if (!id || !serviceName || !serviceVendor) return null;
    return {
      id: id,
      serviceName: serviceName,
      serviceVendor: serviceVendor,
      scopes: readArray(record.scopes).filter(function (scope) { return typeof scope === 'string'; }),
      connectedAt: readString(record.connectedAt) || null,
      canConnect: readBoolean(firstDefined(record.canConnect, record.can_connect)),
      canSend: readBoolean(firstDefined(record.canSend, record.can_send)),
      canRetry: readBoolean(firstDefined(record.canRetry, record.can_retry)),
      isPending: readBoolean(firstDefined(record.isPending, record.is_pending))
    };
  }

  function matchesDescriptor(row, descriptor) {
    var when = objectOrEmpty(descriptor.when);
    var keys = Object.keys(when);
    for (var i = 0; i < keys.length; i += 1) {
      if (row[keys[i]] !== when[keys[i]]) return false;
    }
    return true;
  }

  function stateForRow(row) {
    for (var i = 0; i < STATE_DESCRIPTORS.length; i += 1) {
      if (matchesDescriptor(row, STATE_DESCRIPTORS[i])) return STATE_DESCRIPTORS[i];
    }
    return STATE_DESCRIPTORS[STATE_DESCRIPTORS.length - 1];
  }

  function statusFromFlags(row) {
    return stateForRow(row).id;
  }

  function readServiceConnectionReadinessView(connectionsRaw, configRows) {
    var configs = normalizeConfigRows(configRows);
    var configByVendor = {};
    var connectedVendors = {};
    var rows = [];
    var connections = arrayOrEmpty(connectionsRaw).map(normalizeConnection).filter(Boolean);
    for (var c = 0; c < configs.length; c += 1) configByVendor[configs[c].vendor] = configs[c];
    for (var i = 0; i < connections.length; i += 1) {
      var connection = connections[i];
      connectedVendors[connection.serviceVendor] = true;
      var config = configByVendor[connection.serviceVendor] || {};
      var connectedRow = {
        id: connection.id,
        serviceName: connection.serviceName,
        serviceVendor: connection.serviceVendor,
        purpose: readString(config.instructions),
        category: readString(config.category, 'Your services'),
        logoUrl: readString(config.logoUrl),
        scopes: connection.scopes.length ? connection.scopes : arrayOrEmpty(config.defaultScopes),
        connectedAt: connection.connectedAt,
        canConnect: connection.canConnect,
        canSend: connection.canSend,
        canRetry: connection.canRetry,
        isPending: connection.isPending,
        environments: arrayOrEmpty(config.environments),
        config: config
      };
      connectedRow.status = statusFromFlags(connectedRow);
      rows.push(connectedRow);
    }
    for (var j = 0; j < configs.length; j += 1) {
      var catalog = configs[j];
      if (connectedVendors[catalog.vendor] || !catalog.credentialFields.length) continue;
      var catalogRow = {
        id: 'service_connection:' + catalog.vendor,
        serviceName: catalog.name,
        serviceVendor: catalog.vendor,
        purpose: catalog.instructions,
        category: catalog.category,
        logoUrl: catalog.logoUrl,
        scopes: catalog.defaultScopes,
        connectedAt: null,
        canConnect: true,
        canSend: false,
        canRetry: false,
        isPending: false,
        environments: catalog.environments,
        config: catalog
      };
      catalogRow.status = statusFromFlags(catalogRow);
      rows.push(catalogRow);
    }
    rows.sort(function (left, right) {
      return left.serviceName.localeCompare(right.serviceName) || left.id.localeCompare(right.id);
    });
    if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
      console.info('[service-connections/ios] mounted ' + rows.length + ' rows');
    }
    return rows;
  }

  function inputValueMarker(key) {
    var marker = { '$kind': 'screen.input.value' };
    if (key) marker.key = key;
    return marker;
  }

  function inputKey(lifecycle, row, field) {
    return lifecycle + '::' + row.id + '::' + field.id;
  }

  function mountAction(type, payload) {
    return { operation: MOUNT_ACTION_OPERATION, payload: { type: type, payload: payload || {} } };
  }

  function targetAction(target, payload) {
    return { operation: TARGET_INVOKE_OPERATION, payload: { target: target, payload: payload } };
  }

  var ACTION_BUILDERS = {
    open: function (key, row) { return mountAction('open', { id: row.id }); },
    disconnect: function (_key, row) { return targetAction(DISCONNECT_TARGET, row.id); }
  };

  function connectionTarget(row) {
    return {
      id: row.id,
      serviceName: row.serviceName,
      serviceVendor: row.serviceVendor,
      scopes: row.scopes,
      environments: row.environments
    };
  }

  function connectPayload(key, row) {
    var config = objectOrEmpty(row.config);
    return {
      connection: connectionTarget(row),
      credential: {
        serviceVendor: row.serviceVendor,
        serviceName: row.serviceName,
        fields: arrayOrEmpty(config.credentialFields).map(function (field) {
          return {
            id: field.id,
            label: field.label,
            value: inputValueMarker(inputKey(key, row, field))
          };
        })
      },
      verifyRequest: config.verifyRequest || null,
      environments: row.environments || []
    };
  }

  function actionsForRow(key, row) {
    var descriptor = stateForRow(row);
    return arrayOrEmpty(descriptor.actions).map(function (actionSpec) {
      var builder = ACTION_BUILDERS[actionSpec.intent];
      return typeof builder === 'function'
        ? button(actionSpec.label, builder(key, row), actionSpec.primary === true)
        : null;
    }).filter(Boolean);
  }

  function rowCard(key, row, activeId) {
    var isActive = row.id === activeId;
    var state = stateForRow(row);
    return box({
      background: isActive ? '#132238' : 'darkSurface',
      border: isActive ? 'accent' : 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 12,
      spacing: 8
    }, [
      stack('horizontal', 10, [
        mark(row),
        stack('vertical', 2, [
          text(row.serviceName, 16, 'bold', 'darkTextPrimary', 1),
          row.purpose ? text(row.purpose, 12, 'regular', 'darkTextSecondary', 2) : null
        ], { fillWidth: true }),
        badge(state.label, state.badgeTone)
      ]),
      stack('horizontal', 8, actionsForRow(key, row))
    ]);
  }

  function dialog(key, rows, selectedId) {
    var row = null;
    for (var i = 0; i < rows.length; i += 1) if (rows[i].id === selectedId) row = rows[i];
    if (!row) return null;
    var config = objectOrEmpty(row.config);
    var fields = arrayOrEmpty(config.credentialFields);
    var fieldNodes = fields.map(function (field) {
      return box({
        background: 'darkSurface',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 12,
        padding: 10,
        spacing: 6
      }, [
        text(field.required ? field.label : field.label + ' - you can skip this', 12, 'semibold', 'darkTextPrimary', 1),
        node('text-input', {
          value: '',
          label: field.label,
          placeholder: field.placeholder || '',
          secure: field.secret === true,
          multiline: field.multiline === true,
          submit: targetAction(CONNECT_TARGET, connectPayload(key, row))
        }, [], inputKey(key, row, field)),
        field.help ? text(field.help, 11, 'regular', 'darkTextSecondary', 3) : null,
        field.guideSteps && field.guideSteps.length ? text('Where do I find this? ' + field.guideSteps[0], 11, 'regular', 'darkTextSecondary', 4) : null
      ]);
    });
    if (!fieldNodes.length) fieldNodes.push(text('Ready to connect - nothing required.', 12, 'regular', '#6fdc99', 2));
    return box({
      background: 'darkSurfaceRaised',
      border: 'accent',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 14,
      spacing: 10
    }, [
      stack('horizontal', 10, [
        mark(row),
        stack('vertical', 2, [
          text('Connect ' + row.serviceName, 18, 'bold', 'darkTextPrimary', 2),
          row.purpose ? text(row.purpose, 12, 'regular', 'darkTextSecondary', 3) : null
        ], { fillWidth: true })
      ]),
      stack('vertical', 8, fieldNodes),
      stack('horizontal', 8, [
        button('Cancel', mountAction('close'), false),
        button('Connect', targetAction(CONNECT_TARGET, connectPayload(key, row)), true)
      ])
    ]);
  }

  function buildSnapshot(key, rows, selectedId) {
    var connected = rows.filter(function (row) { return stateForRow(row).group === 'connected'; });
    var available = rows.filter(function (row) { return stateForRow(row).group === 'available'; });
    var children = [
      text('Connected services', 30, 'bold', 'darkTextPrimary', 2),
      text('Connect tools so your packages can act on your behalf.', 13, 'regular', 'darkTextSecondary', 3)
    ];
    if (connected.length) {
      children.push(text('Connected', 13, 'bold', 'darkTextSecondary', 1));
      for (var i = 0; i < connected.length && i < 8; i += 1) children.push(rowCard(key, connected[i], selectedId));
    }
    children.push(text('Available', 13, 'bold', 'darkTextSecondary', 1));
    if (available.length) {
      for (var j = 0; j < available.length && j < 20; j += 1) children.push(rowCard(key, available[j], selectedId));
    } else if (!connected.length) {
      children.push(box({
        background: 'darkSurfaceRaised',
        border: 'darkBorder',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 16,
        spacing: 8
      }, [
        text('Nothing connected yet.', 18, 'semibold', 'darkTextPrimary', 2),
        text('Browse available tools or add one with a key, token, or webhook URL.', 12, 'regular', 'darkTextSecondary', 4)
      ]));
    }
    children.push(box({
      background: 'darkSurfaceRaised',
      border: 'darkBorder',
      borderWidth: 1,
      cornerRadius: 16,
      padding: 12,
      spacing: 6
    }, [
      text("Don't see your tool?", 15, 'semibold', 'darkTextPrimary', 1),
      text('Connect any service with an API key, token, or webhook URL.', 12, 'regular', 'darkTextSecondary', 2)
    ]));
    var activeDialog = dialog(key, rows, selectedId);
    if (activeDialog) children.push(activeDialog);
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 14
      }, children)
    };
  }

  function failureSnapshot(key, error) {
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: 'darkBackground',
        cornerRadius: 0,
        minHeight: 900,
        padding: 22,
        spacing: 12
      }, [
        text('Connected services could not open', 24, 'bold', 'darkTextPrimary', 2),
        text(String(error && error.message ? error.message : error), 13, 'regular', '#ff8f8f', 6)
      ])
    };
  }

  function mountServiceConnections(record, mount) {
    var key = lifecycleKey(record);
    var rows = [];
    var selectedId = '';

    function replace() {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(buildSnapshot(key, rows, selectedId)));
    }

    try {
      rows = readServiceConnectionReadinessView(
        readPackageInput(mount, 'service-connections') || [],
        readPackageInput(mount, 'published-records') || []
      );
      replace();
      mount.invoke(TARGET_INVOKE_BACKGROUND_OPERATION, JSON.stringify({ target: PUBLISH_TARGET, payload: {} }));
    } catch (error) {
      mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(failureSnapshot(key, error)));
    }

    globalThis.bitfieldOnAction = function bitfieldOnAction(payloadText) {
      var action = {};
      try {
        action = JSON.parse(payloadText || '{}');
      } catch (error) {
        action = {};
      }
      if (action.type === 'open') selectedId = readString(objectOrEmpty(action.payload).id);
      if (action.type === 'close') selectedId = '';
      replace();
    };

    return {
      dispose: function () {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({ lifecycle_key: key }));
      }
    };
  }

  globalThis.ServiceConnectionsJscore = {
    sharedContractSourcePaths: SHARED_CONTRACT_SOURCE_PATHS.slice(),
    readServiceConnectionReadinessView: readServiceConnectionReadinessView,
    buildSnapshot: buildSnapshot,
    connectPayload: connectPayload
  };
  globalThis.bitfieldMount = mountServiceConnections;
  globalThis.putThingOnScreen = mountServiceConnections;
}());
