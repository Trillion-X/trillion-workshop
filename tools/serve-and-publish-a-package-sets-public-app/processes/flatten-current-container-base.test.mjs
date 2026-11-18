import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerfileForCurrentImage } from '../../write-a-sales-page/packages/hosted-public-app/processes/flatten-current-container-base.mjs';

test('a full-depth serving image becomes one filesystem layer with its launch settings', () => {
  const image = 'registry.fly.io/example:release-current1';
  const lines = dockerfileForCurrentImage(image, {
    Os: 'linux', Architecture: 'amd64', Config: {
      Env: ['PATH=/usr/bin:/bin', 'BITFIELD_PARTITION=example', 'CONFIG={"key":"value"}'],
      Entrypoint: ['/opt/bitfield/hosted-launcher.sh'], WorkingDir: '/app',
      Cmd: ['serve'], User: '1000:1000', ExposedPorts: { '8080/tcp': {} },
    },
  });
  assert.deepEqual(lines.slice(0, 3), [
    `FROM --platform=linux/amd64 ${image} AS current`,
    'FROM --platform=linux/amd64 scratch',
    'COPY --from=current / /',
  ]);
  assert.ok(lines.includes('ENV CONFIG="{\\"key\\":\\"value\\"}"'));
  assert.ok(lines.includes('WORKDIR "/app"'));
  assert.ok(lines.includes('USER "1000:1000"'));
  assert.ok(lines.includes('EXPOSE 8080/tcp'));
  assert.ok(lines.includes('ENTRYPOINT ["/opt/bitfield/hosted-launcher.sh"]'));
  assert.ok(lines.includes('CMD ["serve"]'));
});

test('flattening refuses an unsupported image or incomplete launch config', () => {
  assert.throws(() => dockerfileForCurrentImage('registry.fly.io/example:other', {}));
  assert.throws(() => dockerfileForCurrentImage('registry.fly.io/example:release-current1', {
    Os: 'linux', Architecture: 'amd64', Config: { Env: [], Entrypoint: [], WorkingDir: '/app' },
  }));
});
