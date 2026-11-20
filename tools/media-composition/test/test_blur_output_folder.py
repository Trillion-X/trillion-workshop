"""blur-faces-not-agreed.py writes its copy where the row declares its output: /opt/media-composition/out/blurred.mp4 in a run.
A run's folder stands for /opt only for what the engine hands the program, so the program finds that folder from its own file
(the same rule as its model folder). The default is checked against a laid-out run folder and against the repository.
"""
import ast
import os
import pathlib
import tempfile
import unittest

DO_WORK = pathlib.Path(__file__).resolve().parent.parent / 'do-work'
SOURCE = DO_WORK / 'blur-faces-not-agreed.py'


def default_out(folder):
    """The value of OUT as the module assigns it, evaluated with the module's own file at `folder`."""
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    node = next(n for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', None) == 'OUT')
    namespace = {'os': os, '__file__': str(folder / 'blur-faces-not-agreed.py')}
    exec(compile(ast.Module([node], []), str(SOURCE), 'exec'), namespace)
    return namespace['OUT']


class BlurOutputFolderTest(unittest.TestCase):
    def test_a_run_writes_to_the_row_output_path_under_its_own_folder(self):
        with tempfile.TemporaryDirectory() as root:
            run = pathlib.Path(root)
            laid = run / 'opt' / 'media-composition' / 'do-work'
            laid.mkdir(parents=True)
            out = pathlib.Path(os.path.normpath(default_out(laid)))
            self.assertEqual(out, run / 'opt' / 'media-composition' / 'out' / 'blurred.mp4')

    def test_by_hand_it_writes_into_the_repository_out_folder(self):
        out = pathlib.Path(os.path.normpath(default_out(DO_WORK)))
        self.assertEqual(out, DO_WORK.parent / 'out' / 'blurred.mp4')

    def test_no_literal_opt_path_is_left(self):
        self.assertNotIn('/opt/media-composition/out', SOURCE.read_text(encoding='utf-8').split('OUT =')[1].split('\n')[0])


if __name__ == '__main__':
    unittest.main()
