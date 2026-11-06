"""Every event type lives in a module here: events/<technique>.py defines one or more ev_<type>(self, e), written as Build
methods. bind() puts each on Build, so a spec event {"type": "<type>", ...} reaches it. Two modules defining the same type,
or a module shadowing a Build method, stop the render by name. Drawing code several events share lives in helpers/."""
import importlib
import os

FOLDER = os.path.dirname(os.path.abspath(__file__))
_BOUND = {}


def modules():
    return sorted(f[:-3] for f in os.listdir(FOLDER) if f.endswith('.py') and f != '__init__.py')


def bind(build_class):
    """Bind every event function of every module onto build_class; returns {type: module name}. Binding twice is a no-op."""
    if _BOUND.get('class') is build_class:
        return _BOUND['owners']
    owners = {}
    for name in modules():
        mod = importlib.import_module(f'overlay.events.{name}')
        found = [n for n, v in vars(mod).items() if n.startswith('ev_') and callable(v) and getattr(v, '__module__', None) == mod.__name__]
        if not found:
            raise SystemExit(f'events/{name}.py defines no ev_<type> function; every module here defines at least one')
        for fn in found:
            if fn[3:] in owners or hasattr(build_class, fn):
                raise SystemExit(f'events/{name}.py: {fn} is already defined by {owners.get(fn[3:], "build.py")}')
            owners[fn[3:]] = mod.__name__
            setattr(build_class, fn, getattr(mod, fn))
    _BOUND.update({'class': build_class, 'owners': owners})
    return owners


def types():
    """Every event type a spec may use, sorted."""
    from overlay.build import Build
    return sorted(bind(Build))
