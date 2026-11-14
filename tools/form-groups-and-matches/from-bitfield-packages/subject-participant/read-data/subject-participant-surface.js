// package://packages/subject-participant/read-data/subject-participant-surface.js

export const packageBoundarySurface = {
  "kind": "package-boundary-surface",
  "packageName": "subject-participant",
  "title": "Subject Participant",
  "capability": "generic-subject-participant",
  "summary": "Generic package for subject_participant_request, subject_participant_projection.",
  "owns": [
    "subject_participant_request",
    "subject_participant_projection"
  ],
  "actions": [
    {
      "action": "upsert-participations",
      "requestShape": "json-object",
      "responseShape": "json-object",
      "executionOwner": "chosen-by-package-set-data"
    },
    {
      "action": "read-subject-participants",
      "requestShape": "json-object",
      "responseShape": "json-object",
      "executionOwner": "chosen-by-package-set-data"
    }
  ],
  "input": {
    "inputName": "subject-participant",
    "valueAddressLabel": "subject-participant",
    "valueContract": {
      "source_bytes": {
        "bytes_to_value": "json"
      }
    }
  },
  "addresses": {
    "primitiveContract": "package::subject-participant::primitive-contract",
    "factflow": "package::subject-participant::factflow::surface",
    "input": "package::subject-participant::input::subject-participant",
    "placeableSurface": "package::subject-participant::placeable-surface::subject-participant"
  },
  "sourceContract": [
    "read package-declared inputs",
    "render browser-local visual state",
    "emit owner-action requests through package-set data",
    "avoid source-system and provider clients",
    "leave execution-owner choice to package-set records"
  ]
};

export function readPackageBoundarySurface() {
  return packageBoundarySurface;
}
