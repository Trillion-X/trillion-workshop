#!/usr/bin/env python3
# packages/chat/do-work/process-scripts/publish-send-route-participants.py
#
# =============================================================================
# PURPOSE
# =============================================================================
#
# Publish addressed-exchange participant records for chat conversation receivers
# who can receive sends. For each conversation with BOTH sendCapability (routing
# metadata) AND sendRef (resolved buddy handle), emit a ReachableEndpoint-shape
# addressed-participant record with ownerTarget routing to the send handler.
#
# Generic over all channels (L090): the send capability's channel + destinationId
# pair maps to ownerTarget without per-channel code branches. Instagram, Telegram,
# Gmail, Discord, WhatsApp, Signal, Slack, or any future channel register ONE
# DATA row in their connector's conversation_source_descriptor; this producer
# consumes it blindly.
#
# Input: chat-sessions window rows (from materialize-conversations.py output)
# Output: addressed-participant feed rows in prop:addressed_participant and
#         prop:addressed_way_to_reach shape for the addressed-exchange consumer
#
# =============================================================================
# CLI: publish-send-route-participants.py <chat-sessions.json> <out-participants.json>
# =============================================================================

import json
import sys
import uuid


def derive_ownerTargetRef(channel: str, destination_id: str) -> str:
    """
    Generic ownerTarget derivation (L090): the send route's target depends
    ONLY on the channel + destinationId pair from the source's send_capability_ref.
    This is not a per-channel branch — the target is DATA (the action to invoke),
    and each channel's send_capability_ref declares its target.

    For now, all sendable sources target the generic egress action via workflow.
    The egress action itself is channel-agnostic and dispatches per channel
    via the send_capability_ref that rides in the workflow input.
    """
    # All sources route sends through the generic submit-message-egress action
    # (defined in content-distribution). The action reads the send_capability_ref
    # (channel, destinationId, frontDoorAction) and routes the send.
    return "action:submit-message-egress"


def build_participant_rows(conversation_row: dict) -> list:
    """
    For ONE conversation row that is sendable (has both sendCapability and sendRef),
    emit the addressed-participant feed rows needed for the send route to appear.

    Returns:
      - One participant row (prop:addressed_participant:*)
      - One way-to-reach row (prop:addressed_way_to_reach:*) with ownerTarget

    Rows are keyed by a stable participant_id derived from (channel, sendRef).
    Non-sendable rows (missing sendCapability or sendRef) return [].
    """
    rows = []

    # Only process sendable conversations
    send_cap = conversation_row.get("sendCapability")
    send_ref = conversation_row.get("sendRef")

    if not send_cap or not send_ref:
        return []  # Fail closed: non-sendable thread yields no participant rows

    if not isinstance(send_cap, dict):
        return []

    channel = send_cap.get("channel")
    destination_id = send_cap.get("destinationId")
    if not channel or not destination_id:
        return []  # Partial capability: skip

    # Stable participant id: (channel, sendRef, destination) triple
    # Two threads to the SAME recipient (e.g. two iMessages with "+1234567890")
    # converge to the same participant, so Send shows one route option.
    participant_id = f"participant:send-route:{channel}:{destination_id}:{send_ref}"
    way_id = f"{participant_id}-way"

    # Participant row: addresses the receiver by their channel-specific handle
    rows.append({
        "subject_id": participant_id,
        "property_id": "prop:addressed_participant:participant_ref",
        "value": participant_id
    })

    rows.append({
        "subject_id": participant_id,
        "property_id": "prop:addressed_participant:label",
        "value": send_ref  # The buddy handle as-is (phone, email, username, etc.)
    })

    rows.append({
        "subject_id": participant_id,
        "property_id": "prop:addressed_participant:default_way_to_reach_ref",
        "value": way_id
    })

    rows.append({
        "subject_id": participant_id,
        "property_id": "prop:addressed_participant:metadata",
        "value": {
            "channel": channel,
            "destination_id": destination_id,
            "send_capability_ref": send_cap
        }
    })

    # Way-to-reach row: the ROUTE to send to this participant
    # ownerTargetRef points to the send action; the send action reads the
    # send_capability_ref (embedded in metadata, carried to the action) to
    # know WHICH channel to use for THIS participant.
    rows.append({
        "subject_id": way_id,
        "property_id": "prop:addressed_way_to_reach:way_ref",
        "value": way_id
    })

    rows.append({
        "subject_id": way_id,
        "property_id": "prop:addressed_way_to_reach:participant_ref",
        "value": participant_id
    })

    rows.append({
        "subject_id": way_id,
        "property_id": "prop:addressed_way_to_reach:label",
        "value": send_ref
    })

    owner_target_ref = derive_ownerTargetRef(channel, destination_id)
    rows.append({
        "subject_id": way_id,
        "property_id": "prop:addressed_way_to_reach:owner_target_ref",
        "value": owner_target_ref
    })

    # Adapter: addressed-exchange kind means this way-to-reach routes via
    # an owner target (a workflow action), not a process-session.
    rows.append({
        "subject_id": way_id,
        "property_id": "prop:addressed_way_to_reach:adapter",
        "value": {
            "kind": "addressed-exchange",
            "ownerTargetRef": owner_target_ref,
            "requiresAuth": False
        }
    })

    return rows


def main():
    if len(sys.argv) < 3:
        print("Usage: publish-send-route-participants.py <chat-sessions.json> <out-participants.json>")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    # Read chat sessions (either raw array or wrapped in envelope)
    try:
        with open(input_file) as f:
            input_data = json.load(f)
    except (IOError, json.JSONDecodeError) as e:
        print(f"Error reading input: {e}", file=sys.stderr)
        sys.exit(1)

    # Peel envelope (payload/sources/rows/etc keys)
    if isinstance(input_data, dict):
        for key in ["payload", "sources", "records", "rows", "items", "results"]:
            if isinstance(input_data.get(key), list):
                conversations = input_data[key]
                break
        else:
            conversations = [input_data] if input_data else []
    else:
        conversations = input_data if isinstance(input_data, list) else []

    # Emit participant rows for each sendable conversation
    all_rows = []
    for conv in conversations:
        if isinstance(conv, dict):
            all_rows.extend(build_participant_rows(conv))

    # Dedup: keep only the first occurrence of each (subject_id, property_id) pair
    seen = set()
    deduped = []
    for row in all_rows:
        key = (row.get("subject_id"), row.get("property_id"))
        if key not in seen:
            seen.add(key)
            deduped.append(row)

    # Write output
    try:
        with open(output_file, "w") as f:
            json.dump({"rows": deduped}, f, indent=2)
    except IOError as e:
        print(f"Error writing output: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
