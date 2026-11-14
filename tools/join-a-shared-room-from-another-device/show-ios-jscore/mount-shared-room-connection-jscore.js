// Purpose: package-owned native join surface for installed-app screen commands.
// Invariants: platform code stays generic; this file owns only shared-room
// connection society data and writes through the generic label-addressed target.

(function () {
  var TARGET_INVOKE_OPERATION = 'runtime.target.invoke';
  var SCREEN_SCENE_REPLACE_OPERATION = 'screen.scene.replace';
  var SNAPSHOT_REPLACE_OPERATION = 'native.view.snapshot.replace';
  var SNAPSHOT_DISPOSE_OPERATION = 'native.view.snapshot.dispose';
  var ENGINE_LABEL_TARGET = 'engine.operation.label-addressed';
  var READ_CURRENT = 'engine.operation.read-current';
  var WRITE_BATCH = 'engine.operation.write-batch';
  var JOINED_ADDRESS = 'shared-room-connection.joined-devices';
  var SURFACE_SOURCE = 'packages/shared-room-connection/show-ios-jscore/mount-shared-room-connection-jscore.js';
  var SURFACE_LIFECYCLE = 'component:shared-room-connection:jscore';

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function listOrEmpty(value) {
    return Array.isArray(value) ? value : [];
  }

  function readString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  }

  function lifecycleKey(record) {
    return readString(record && record.lifecycle_key) || SURFACE_LIFECYCLE;
  }

  function node(kind, props, children) {
    return {
      kind: kind,
      props: objectOrEmpty(props),
      children: listOrEmpty(children)
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

  function input(key, placeholder, value) {
    return node('input', {
      key: key,
      value: value || '',
      placeholder: placeholder,
      size: 18,
      weight: 'semibold',
      color: 'darkTextPrimary',
      background: '#061b12',
      border: '#1e6f52',
      borderWidth: 1,
      cornerRadius: 18,
      padding: 15
    });
  }

  function button(label, action, variant) {
    var primary = variant === 'primary';
    return node('box', {
      background: primary ? '#f8fff9' : '#082417',
      border: primary ? '#f8fff9' : '#1d6b4e',
      borderWidth: 1,
      cornerRadius: 22,
      padding: 16,
      fillWidth: false,
      press: action
    }, [
      text(label, 17, 'heavy', primary ? '#03120c' : 'darkTextPrimary')
    ]);
  }

  function runtimeTarget(mount, target, payload) {
    var responseText = mount.invoke(TARGET_INVOKE_OPERATION, JSON.stringify({
      target: target,
      payload: payload
    }));
    if (!responseText) return {};
    return JSON.parse(responseText);
  }

  function readJoinedRecord(mount) {
    try {
      var reply = runtimeTarget(mount, ENGINE_LABEL_TARGET, {
        operation_label: READ_CURRENT,
        address_label: JOINED_ADDRESS
      });
      var value = objectOrEmpty(reply.payload);
      if (value.kind === 'shared-room-connection.joined-devices' && value.version === 1) {
        return {
          kind: value.kind,
          version: 1,
          participants: listOrEmpty(value.participants).map(objectOrEmpty)
        };
      }
    } catch (error) {
      return emptyJoinedRecord();
    }
    return emptyJoinedRecord();
  }

  function emptyJoinedRecord() {
    return {
      kind: 'shared-room-connection.joined-devices',
      version: 1,
      participants: []
    };
  }

  function inputValue(key) {
    return {
      '$kind': 'screen.input.value',
      key: key,
      fallback: ''
    };
  }

  function selfScene(props) {
    return {
      id: 'shared-room-connection.native-scene',
      props: {
        things_to_put_on_screen: [
          {
            source_path: SURFACE_SOURCE,
            required_capabilities: ['can-put-thing-on-screen-using-screen-commands'],
            lifecycle_key: SURFACE_LIFECYCLE,
            props: Object.assign({ entry_function: 'bitfieldMount' }, objectOrEmpty(props))
          }
        ]
      }
    };
  }

  function upsertParticipant(record, previousName) {
    var participantName = inputValue('participant_name');
    var participants = record.participants.slice(0, 24);
    var replaced = false;
    if (previousName) {
      participants = participants.map(function (participant) {
        if (readString(participant.displayName) !== previousName) return participant;
        replaced = true;
        return Object.assign({}, participant, {
          displayName: participantName,
          connected: true
        });
      });
    }
    if (!replaced) {
      participants.push({
        displayName: participantName,
        connected: true
      });
    }
    return {
      kind: record.kind,
      version: record.version,
      participants: participants
    };
  }

  function commitAndReloadAction(record, previousName) {
    var nextRecord = upsertParticipant(record, previousName);
    return {
      operations: [
        {
          operation: TARGET_INVOKE_OPERATION,
          payload: {
            target: ENGINE_LABEL_TARGET,
            payload: {
              operation_label: WRITE_BATCH,
              writes: [
                {
                  address_label: JOINED_ADDRESS,
                  path_labels: ['shared-room-connection', 'joined-devices'],
                  payload: nextRecord
                }
              ]
            }
          }
        },
        {
          operation: SCREEN_SCENE_REPLACE_OPERATION,
          payload: selfScene({
            participant_name: inputValue('participant_name')
          })
        }
      ]
    };
  }

  function participantRows(record) {
    var participants = record.participants;
    if (participants.length === 0) {
      return [
        node('box', {
          background: '#04140d',
          border: '#183e2e',
          borderWidth: 1,
          cornerRadius: 18,
          padding: 16
        }, [text('No joined devices yet.', 15, 'semibold', 'darkTextSecondary')])
      ];
    }
    return participants.map(function (participant, index) {
      return node('box', {
        background: '#061b12',
        border: '#1b4f3c',
        borderWidth: 1,
        cornerRadius: 18,
        padding: 14
      }, [
        text((index + 1) + '. ' + (readString(participant.displayName) || 'Joined device'), 16, 'bold', 'darkTextPrimary')
      ]);
    });
  }

  function buildSnapshot(record, mount) {
    var key = lifecycleKey(record);
    var props = objectOrEmpty(record && record.props);
    var joined = readJoinedRecord(mount);
    var participantName = readString(props.participant_name);
    return {
      schema: 'bitfield.native.view.snapshot',
      lifecycle_key: key,
      root: node('screen', {
        background: '#020806',
        minHeight: 900,
        padding: 18,
        spacing: 16
      }, [
        node('box', {
          background: '#06150e',
          border: '#1e6f52',
          borderWidth: 1,
          cornerRadius: 34,
          padding: 26,
          spacing: 18
        }, [
          node('box', {
            background: '#183a2b',
            border: '#3ca878',
            borderWidth: 1,
            cornerRadius: 24,
            padding: 16,
            fillWidth: false
          }, [text('♣', 44, 'regular', '#dffff0')]),
          text('Join the table', 54, 'heavy', 'darkTextPrimary'),
          text('Type your name and tap Join. This package writes a generic Bitfield room-connection fact; peer byte exchange is handled by the shared connection layer, not by the poker table.', 15, 'regular', 'darkTextSecondary'),
          node('box', {
            background: '#020f09',
            border: '#183e2e',
            borderWidth: 1,
            cornerRadius: 26,
            padding: 18,
            spacing: 12
          }, [
            text('Joined devices', 20, 'bold', 'darkTextPrimary'),
            node('stack', { axis: 'vertical', spacing: 9 }, participantRows(joined))
          ]),
          input('participant_name', 'Your name', participantName),
          node('stack', { axis: 'horizontal', spacing: 12 }, [
            button(participantName ? 'Update my name' : 'Join table', commitAndReloadAction(joined, participantName), 'primary')
          ])
        ])
      ])
    };
  }

  globalThis.bitfieldMount = function bitfieldMount(record, mount) {
    var snapshot = buildSnapshot(record, mount);
    mount.invoke(SNAPSHOT_REPLACE_OPERATION, JSON.stringify(snapshot));
    return {
      dispose: function dispose() {
        mount.invoke(SNAPSHOT_DISPOSE_OPERATION, JSON.stringify({
          lifecycle_key: snapshot.lifecycle_key
        }));
      }
    };
  };
}());

