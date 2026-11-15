// The real protected interpreter checks the public kernel layout and malformed-observation refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('birth-qualified group observations preserve captured members and refuse unsupported or malformed layouts', () => {
  const reader = fileURLToPath(new URL('../read-data/mac-process-inspection.py', import.meta.url));
  const script = String.raw`
import importlib.util, os, struct, sys, unittest
from unittest import mock
spec = importlib.util.spec_from_file_location('process_observer', sys.argv[1])
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
class Groups(unittest.TestCase):
    def setUp(self):
        self.stride = reader.kernel_stride()
        self.raw = reader.kernel_process_bytes(reader.KERN_PROC_PID, os.getpid())
    def test_real_kernel_group_and_birth(self):
        groups = reader.kernel_process_groups(reader.kernel_process_bytes(reader.KERN_PROC_ALL), self.stride)
        self.assertEqual(os.getpgid(os.getpid()), groups[(os.getpid(), tuple(reader.process_birth(os.getpid())))])
    def test_captured_member_needs_no_live_lookup(self):
        raw = bytearray(self.raw)
        struct.pack_into('i', raw, 40, 123456789)
        struct.pack_into('i', raw, 564, 98765)
        original = os.getpgid
        def group(pid):
            if pid != os.getpid():
                raise ProcessLookupError('captured process is gone')
            return original(pid)
        with mock.patch.object(reader.os, 'getpgid', side_effect=group) as lookup:
            groups = reader.kernel_process_groups(raw, self.stride)
        self.assertEqual(groups[(123456789, tuple(reader.process_birth(os.getpid())))], 98765)
        self.assertTrue(all(call.args == (os.getpid(),) for call in lookup.call_args_list))
    def test_partial_duplicate_empty_and_negative_group_refuse(self):
        bad = bytearray(self.raw)
        struct.pack_into('i', bad, 564, -1)
        for raw in [b'', self.raw[:-1], self.raw + self.raw, bad]:
            with self.subTest(length=len(raw)), self.assertRaises(RuntimeError):
                reader.kernel_process_groups(raw, self.stride)
    def test_unsupported_stride_refuses(self):
        with self.assertRaises(RuntimeError):
            reader.kernel_process_groups(self.raw, self.stride - 1)
    def test_live_group_mismatch_refuses(self):
        with mock.patch.object(reader.os, 'getpgid', return_value=os.getpgid(os.getpid()) + 1):
            with self.assertRaises(RuntimeError):
                reader.kernel_process_groups(self.raw, self.stride)
    def test_complete_table_can_grow_within_the_existing_bound(self):
        captured, capacities = self.raw * 2, []
        class Sysctl:
            def __call__(self, mib, count, output, size, ignored, ignored_size):
                if output is None:
                    size._obj.value = len(captured) // 2
                else:
                    capacities.append(size._obj.value)
                    reader.ctypes.memmove(output, captured, len(captured))
                    size._obj.value = len(captured)
                return 0
        from types import SimpleNamespace
        with mock.patch.object(reader.ctypes, 'CDLL', return_value=SimpleNamespace(sysctl=Sysctl())):
            self.assertEqual(captured, reader.kernel_process_bytes(reader.KERN_PROC_ALL))
        self.assertEqual([reader.MAX_KERNEL_SNAPSHOT], capacities)
    def test_complete_table_over_the_existing_bound_still_refuses(self):
        class Sysctl:
            def __call__(self, mib, count, output, size, ignored, ignored_size):
                size._obj.value = len(self_raw) if output is None else reader.MAX_KERNEL_SNAPSHOT + 1
                return 0
        self_raw = self.raw
        from types import SimpleNamespace
        with mock.patch.object(reader.ctypes, 'CDLL', return_value=SimpleNamespace(sysctl=Sysctl())):
            with self.assertRaises(RuntimeError):
                reader.kernel_process_bytes(reader.KERN_PROC_ALL)
unittest.main(argv=['kernel-group-observations'], verbosity=2)
`;
  const result = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', script, reader], { encoding: 'utf8' });
  assert.equal(result, '');
});
