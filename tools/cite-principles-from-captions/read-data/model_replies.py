"""Model reply admission and local schema checks; no requests, credentials or shared reply state."""
import json
import math
from decimal import Decimal, DecimalException

JSON_WHITESPACE = " \t\r\n"


def _unicode(value):
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
    elif isinstance(value, dict):
        for key, item in value.items():
            _unicode(key)
            _unicode(item)
    elif isinstance(value, list):
        for item in value:
            _unicode(item)


def _finite_float(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("JSON number exceeds the supported finite float range.")
    try:
        if Decimal(text) != Decimal(str(value)):
            raise ValueError("JSON number would change value in the supported numeric representation.")
    except DecimalException as error:
        raise ValueError("JSON number exceeds the supported decimal comparison range.") from error
    return value

def _decoder():
    def members(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON member.")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("Non-finite JSON constant.")


    return json.JSONDecoder(object_pairs_hook=members, parse_constant=constant, parse_float=_finite_float)


def strict_json(text):
    try:
        if isinstance(text, bytes):
            text = text.decode("utf-8")
        value = _decoder().decode(text)
        _unicode(value)
        return value
    except (UnicodeError, RecursionError, OverflowError) as error:
        raise ValueError("JSON exceeds the supported Unicode, nesting or numeric representation.") from error


class ManyValues(list):
    pass


def http_values(text):
    """Parse framing at value boundaries, never by rewriting the contents of JSON strings."""
    values, at, fenced, decoder = [], 0, False, _decoder()
    try:
        while True:
            while at < len(text) and text[at] in JSON_WHITESPACE:
                at += 1
            if at == len(text):
                break
            if text.startswith("<think>", at):
                end = text.find("</think>", at + 7)
                if end < 0:
                    raise ValueError("Unclosed HTTP thinking frame.")
                at = end + len("</think>")
                continue
            if text.startswith("```", at):
                if fenced:
                    at += 3
                    fenced = False
                else:
                    end = text.find("\n", at + 3)
                    if end < 0:
                        raise ValueError("Unclosed HTTP code frame.")
                    if text[at + 3:end].strip(JSON_WHITESPACE).lower() not in ("", "json"):
                        raise ValueError("HTTP code frame opener must be a bare fence or a json fence.")
                    at = end + 1
                    fenced = True
                continue
            value, at = decoder.raw_decode(text, at)
            _unicode(value)
            values.append(value)
    except (UnicodeError, RecursionError, OverflowError) as error:
        raise ValueError("HTTP JSON exceeds the supported representation.") from error
    if fenced or not values:
        raise ValueError("HTTP answer needs complete JSON and closed framing.")
    return values


class Answer(tuple):
    def __new__(cls, content, usage, evidence, value=None):
        answer = super().__new__(cls, (content, usage, evidence))
        answer.value = value
        return answer


def observed(reply):
    """Diagnostic claims only, including rejected replies. Never retain arbitrary error bodies or headers."""
    if not isinstance(reply, dict):
        return {"reply_type": type(reply).__name__}
    evidence = {}
    for key in ("model", "served_by", "exit_code", "tool", "replayed"):
        if key in reply:
            value = reply[key]
            if type(value) in (str, int, bool) or value is None:
                evidence[key] = value
            else:
                evidence[key + "_type"] = type(value).__name__
    choices = reply.get("choices")
    if isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict):
        reason = choices[0].get("finish_reason")
        if isinstance(reason, str) or reason is None:
            evidence["finish_reason"] = reason
    if isinstance(reply.get("usage"), dict):
        evidence["reported_usage"] = {key: value for key, value in reply["usage"].items()
                                      if key in ("prompt_tokens", "completion_tokens", "total_tokens")
                                      and type(value) is int and value >= 0}
    elif reply.get("usage") is not None:
        evidence["usage_type"] = type(reply["usage"]).__name__
    return evidence


REPLY_CLAIM_FIELDS = {"model", "served_by", "finish_reason", "reported_usage", "usage_type", "model_type", "served_by_type", "reply_type"}
OWNER_CLAIM_FIELDS = {"exit_code", "tool", "replayed", "reply_type"}


def reply_observed(reply):
    return {key: value for key, value in observed(reply).items() if key in REPLY_CLAIM_FIELDS}


def owner_observed(reply):
    return {key: value for key, value in observed(reply).items() if key in OWNER_CLAIM_FIELDS}


def diagnostic_claims(text, workshop=False):
    """Safe unambiguous claims from a rejected document, never an alternative admission path."""
    unavailable = object()
    def members(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate diagnostic member.")
            result[key] = value
        return result
    def safe_observed(value):
        if value is unavailable:
            return {}
        if isinstance(value, dict):
            value = {key: item for key, item in value.items() if item is not unavailable}
        result = {}
        for key, claim in observed(value).items():
            try:
                _unicode(claim)
            except (UnicodeError, RecursionError):
                continue
            result[key] = claim
        return result
    try:
        if isinstance(text, bytes):
            text = text.decode("utf-8")
        def available_float(literal):
            try:
                return _finite_float(literal)
            except (ValueError, OverflowError):
                return unavailable
        value = json.JSONDecoder(object_pairs_hook=members, parse_float=available_float,
                                 parse_constant=lambda _: unavailable, parse_int=int).decode(text)
        def reply_claims(reply):
            return {key: claim for key, claim in safe_observed(reply).items() if key in REPLY_CLAIM_FIELDS}
        if workshop:
            owner = safe_observed(value)
            return {"owner_receipt": {key: claim for key, claim in owner.items() if key in OWNER_CLAIM_FIELDS},
                    **reply_claims(value.get("result") if isinstance(value, dict) else None)}
        return reply_claims(value)
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        return {}


def prepare_schema(schema):
    if schema is None:
        return None
    try:
        import jsonschema
        from referencing import Registry, Resource
        from referencing.exceptions import NoSuchResource
        from referencing.jsonschema import specification_with
    except ImportError as error:
        raise ValueError("Extraction with reply_schema needs jsonschema and referencing.") from error

    def unavailable(uri):
        raise NoSuchResource(ref=uri)

    try:
        # A JSON-value copy gives locations one parent, without changing the caller's request schema.
        schema = strict_json(json.dumps(schema, ensure_ascii=False, allow_nan=False))
        def check_dialect(value):
            if isinstance(value, dict) and "$schema" in value and jsonschema.validators.validator_for(value, default=None) is None:
                raise ValueError("Unsupported JSON Schema dialect.")
        check_dialect(schema)
        cls = jsonschema.validators.validator_for(schema, default=jsonschema.Draft202012Validator)
        dialect = cls.META_SCHEMA.get("$id", cls.META_SCHEMA.get("id"))
        resource = Resource.from_contents(schema, default_specification=specification_with(dialect))
        registry = Registry(retrieve=unavailable).with_resource("urn:caption-extraction:schema", resource).crawl()
        resolver = registry.resolver_with_root(resource)
        validators_by_specification = {
            specification_with(validator.META_SCHEMA.get("$id", validator.META_SCHEMA.get("id"))).name: validator
            for validator in (jsonschema.Draft3Validator, jsonschema.Draft4Validator, jsonschema.Draft6Validator,
                              jsonschema.Draft7Validator, jsonschema.Draft201909Validator, jsonschema.Draft202012Validator)
        }
        parents = {}
        def index_parents(value, parent=None):
            if isinstance(value, (dict, list)):
                parents[id(value)] = parent
                for child in (value.values() if isinstance(value, dict) else value):
                    index_parents(child, id(value))
        index_parents(schema)
        boundaries = {id(schema): resource._specification}

        def inherited(value, fallback):
            current = id(value)
            while current in parents:
                if current in boundaries:
                    return boundaries[current]
                current = parents[current]
            return fallback

        def schema_view(item):
            # Each supported embedded dialect gets its own metaschema check.
            masked = set()
            def find(current):
                for child in current.subresources():
                    if child._specification != item._specification:
                        masked.add(id(child.contents))
                    else:
                        find(child)
            find(item)
            def copy(value):
                if id(value) in masked:
                    return {}
                if isinstance(value, dict):
                    return {key: copy(child) for key, child in value.items()}
                if isinstance(value, list):
                    return [copy(child) for child in value]
                return value
            return copy(item.contents)

        def pass_over(validate=False):
            found, errors, visited = {id(schema): resource._specification}, [], set()
            def item_for(value, fallback, at_reference=False):
                check_dialect(value)
                effective = inherited(value, fallback) if at_reference else fallback
                item = Resource.from_contents(value, default_specification=effective)
                if isinstance(value, dict) and "$schema" in value:
                    found[id(value)] = item._specification
                return item
            def failed(error):
                if validate:
                    raise error
                errors.append(error)
            def walk(item, here, validate_target=False):
                try:
                    item = item_for(item.contents, item._specification)
                    active = validators_by_specification[item._specification.name]
                    key = (id(item.contents), here._base_uri, item._specification.name)
                    if key in visited:
                        return
                    visited.add(key)
                    if validate and validate_target:
                        active.check_schema(schema_view(item))
                    if isinstance(item.contents, dict):
                        for keyword in ("$ref", "$dynamicRef", "$recursiveRef"):
                            if keyword not in active.VALIDATORS or keyword not in item.contents:
                                continue
                            try:
                                resolved = here.lookup(item.contents[keyword])
                                containing = resolved.resolver._registry.get_or_retrieve(resolved.resolver._base_uri).value
                                target = item_for(resolved.contents, containing._specification, at_reference=True)
                            except Exception as error:
                                failed(error)
                                continue
                            if (validate and target._specification != item._specification
                                    and isinstance(target.contents, dict) and "$schema" not in target.contents):
                                raise ValueError("Cross-dialect reference fragments require an explicit supported $schema at the target for runtime enforcement.")
                            walk(target, resolved.resolver, True)
                    for child in item.subresources():
                        try:
                            child = item_for(child.contents, child._specification)
                        except Exception as error:
                            failed(error)
                            continue
                        walk(child, here.in_subresource(child), child._specification != item._specification)
                except Exception as error:
                    failed(error)
            walk(resource, resolver, True)
            return found, errors

        # Each discovery pass uses the previous boundary set. Tentative errors and declarations
        # are rebuilt from reachable paths, so a corrected inherited dialect retracts stale ones.
        seen_boundary_sets = set()
        while True:
            fingerprint = frozenset((node, spec.name) for node, spec in boundaries.items())
            if fingerprint in seen_boundary_sets:
                raise ValueError("Schema dialect discovery does not converge.")
            seen_boundary_sets.add(fingerprint)
            found, errors = pass_over()
            if found == boundaries:
                if errors:
                    raise errors[0]
                break
            boundaries = found
        found, errors = pass_over(validate=True)
        if found != boundaries or errors:
            raise ValueError("Schema dialect discovery did not stabilize.")
        return cls(schema, registry=registry)
    except Exception as error:
        raise ValueError("Invalid extraction reply_schema or unavailable local reference.") from error


def value_of(content, validator, require_object=False):
    try:
        if require_object:
            value = strict_json(content)
        else:
            values = http_values(content)
            if len(values) != 1:
                if validator is not None:
                    raise ValueError("Configured HTTP schema requires one complete JSON value.")
                return ManyValues(values)
            value = values[0]
    except ValueError as error:
        raise ValueError("Model answer is not one complete strict JSON value.") from error
    if require_object and not isinstance(value, dict):
        raise ValueError("Workshop answer must be a JSON object.")
    if validator is not None:
        try:
            validator.validate(value)
        except Exception as error:
            raise ValueError("Model answer does not satisfy the unchanged extraction reply_schema.") from error
    return value


def admit(reply, transport, requested_model=None, endpoint_host=None):
    if not isinstance(reply, dict) or reply.get("error") is not None or ("isError" in reply and reply["isError"] is not False):
        raise ValueError("Model owner returned an error or no chat reply.")
    choices = reply.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise ValueError("Model reply needs exactly one completed choice.")
    choice = choices[0]
    if choice.get("finish_reason") != "stop":
        raise ValueError("Model reply did not finish with stop; incomplete answers are not admitted.")
    message = choice.get("message")
    if not isinstance(message, dict) or message.get("tool_calls") or message.get("function_call") or message.get("refusal"):
        raise ValueError("Model reply requested a tool, refused, or has no message.")
    if message.get("role") not in (None, "assistant"):
        raise ValueError("Model reply is not an assistant answer.")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Model reply has no text answer.")
    reported, route = reply.get("model"), reply.get("served_by")
    if reported is not None and (not isinstance(reported, str) or not reported.strip()):
        raise ValueError("Model reply has an invalid reported model identity.")
    model = reported if reported is not None else requested_model
    if not isinstance(model, str) or not model.strip():
        raise ValueError("Model reply has no valid model identity.")
    if route is not None and (not isinstance(route, str) or not route.strip()):
        raise ValueError("Model reply has an invalid route identity.")
    if transport == "workshop" and (reported is None or route is None):
        raise ValueError("Workshop reply must identify its actual model and served_by route.")
    usage = reply.get("usage")
    if usage is None:
        usage = {}
    if not isinstance(usage, dict):
        raise ValueError("Model usage must be an object.")
    used = {}
    for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
        if field in usage:
            if type(usage[field]) is not int or not 0 <= usage[field] <= 2 ** 53 - 1:
                raise ValueError("Model token counters must be nonnegative exact JSON wire integers (at most 2**53-1).")
            used[field] = usage[field]
    evidence = {"transport": transport, "model": model, "model_reported": reported is not None,
                "finish_reason": "stop", "usage_fields_reported": list(used)}
    if route is not None:
        evidence["served_by"] = route
    if transport == "http":
        evidence.update(requested_model=requested_model, endpoint_host=endpoint_host)
    return content, used, evidence


def row_content(row):
    """Call evidence is retained separately; it cannot manufacture another source finding."""
    content = {key: value for key, value in row.items() if key not in ("id", "extracted_by", "extraction_model", "extraction_models")}
    # Encode typed values directly with an explicit stack; do not double the accepted nesting depth.
    pieces, stack = [], [(False, content)]
    while stack:
        raw, value = stack.pop()
        if raw:
            pieces.append(value)
        elif isinstance(value, dict):
            pieces.append("{")
            stack.append((True, "}"))
            for index, (key, child) in reversed(list(enumerate(sorted(value.items())))):
                stack.append((False, child))
                stack.append((True, ("," if index else "") + json.dumps(key, ensure_ascii=False) + ":"))
        elif isinstance(value, list):
            pieces.append("[")
            stack.append((True, "]"))
            for index in range(len(value) - 1, -1, -1):
                stack.append((False, value[index]))
                if index:
                    stack.append((True, ","))
        elif type(value) in (int, float):
            decimal = Decimal(value) if type(value) is int else Decimal(str(value))
            numerator, denominator = decimal.as_integer_ratio()
            pieces.append("#" + str(numerator) + "/" + str(denominator) + ";")
        else:
            pieces.append(json.dumps(value, ensure_ascii=False, allow_nan=False))
    return "".join(pieces)
