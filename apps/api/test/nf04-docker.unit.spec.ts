import { resolve } from 'node:path';
import { assertLiveNf04DockerEvidence, Nf04DockerInspector } from '../src/nf04/nf04-docker';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';

class DockerInspectRunner implements Nf04ProcessRunner {
  readonly calls: Nf04ProcessSpec[] = [];

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    const kind = spec.args[0];
    const stdout =
      kind === 'container'
        ? JSON.stringify([
            {
              Id: 'source-container-object-id',
              Name: '/mh-nf04-20260913-143000-a1b2c3d4-src',
              Image: `sha256:${'a'.repeat(64)}`,
              Config: {
                Image: 'postgres:18.6-alpine',
                Labels: {
                  'mh.nf04.run': '20260913-143000-a1b2c3d4',
                  'mh.nf04.role': 'source',
                },
              },
              Mounts: [
                {
                  Type: 'volume',
                  Name: 'mh_nf04_a1b2c3d4_src_data',
                  Source: '/docker/source',
                  Destination: '/var/lib/postgresql/18/docker',
                  RW: true,
                },
                {
                  Type: 'bind',
                  Source: resolve('E:/study-project/handoff/nf04-backup-restore/run'),
                  Destination: '/nf04-output',
                  RW: true,
                },
              ],
              NetworkSettings: {
                Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55431' }] },
                Networks: { mh_nf04_a1b2c3d4_network: {} },
              },
            },
          ])
        : kind === 'volume'
          ? JSON.stringify([
              {
                Name: 'mh_nf04_a1b2c3d4_src_data',
                Driver: 'local',
                Mountpoint: resolve('E:/docker/volumes/source'),
                Labels: {
                  'mh.nf04.run': '20260913-143000-a1b2c3d4',
                  'mh.nf04.role': 'source',
                },
              },
            ])
          : JSON.stringify([
              {
                Id: 'network-object-id',
                Name: 'mh_nf04_a1b2c3d4_network',
                Driver: 'bridge',
                Labels: {
                  'mh.nf04.run': '20260913-143000-a1b2c3d4',
                  'mh.nf04.role': 'network',
                },
              },
            ]);
    return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false };
  }

  start(): Nf04RunningProcess {
    throw new Error('not used');
  }
}

describe('NF-04 exact Docker inspection', () => {
  it('uses recorded IDs/names and compares the full live identity without name discovery', async () => {
    const runner = new DockerInspectRunner();
    const inspector = new Nf04DockerInspector(runner);
    const manifest = {
      observed: {
        sourceContainer: {
          id: 'source-container-object-id',
          name: 'mh-nf04-20260913-143000-a1b2c3d4-src',
          imageId: `sha256:${'a'.repeat(64)}`,
          imageReference: 'postgres:18.6-alpine' as const,
          labels: {
            'mh.nf04.run': '20260913-143000-a1b2c3d4',
            'mh.nf04.role': 'source',
          },
          mounts: [
            {
              type: 'volume' as const,
              source: '/docker/source',
              destination: '/var/lib/postgresql/18/docker',
              readWrite: true,
              volumeName: 'mh_nf04_a1b2c3d4_src_data',
            },
            {
              type: 'bind' as const,
              source: resolve('E:/study-project/handoff/nf04-backup-restore/run'),
              destination: '/nf04-output',
              readWrite: true,
            },
          ],
          networkNames: ['mh_nf04_a1b2c3d4_network'],
          hostPort: 55431,
        },
        sourceVolume: {
          name: 'mh_nf04_a1b2c3d4_src_data',
          driver: 'local',
          mountpoint: resolve('E:/docker/volumes/source'),
          labels: {
            'mh.nf04.run': '20260913-143000-a1b2c3d4',
            'mh.nf04.role': 'source',
          },
        },
        network: {
          id: 'network-object-id',
          name: 'mh_nf04_a1b2c3d4_network',
          driver: 'bridge',
          labels: {
            'mh.nf04.run': '20260913-143000-a1b2c3d4',
            'mh.nf04.role': 'network',
          },
        },
      },
    };
    const live = await inspector.inspectRecorded(manifest as never, 'source');
    expect(() =>
      assertLiveNf04DockerEvidence(
        {
          container: manifest.observed.sourceContainer,
          volume: manifest.observed.sourceVolume,
          network: manifest.observed.network,
        },
        live,
      ),
    ).not.toThrow();
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['container', 'inspect', 'source-container-object-id'],
      ['volume', 'inspect', 'mh_nf04_a1b2c3d4_src_data'],
      ['network', 'inspect', 'network-object-id'],
    ]);
    expect(() =>
      assertLiveNf04DockerEvidence(
        {
          container: manifest.observed.sourceContainer,
          volume: manifest.observed.sourceVolume,
          network: manifest.observed.network,
        },
        { ...live, container: { ...live.container, id: 'replacement-container-id' } },
      ),
    ).toThrow(/does not match/i);
  });

  it('rejects non-loopback PostgreSQL bindings', async () => {
    const runner = new DockerInspectRunner();
    const originalRun = runner.run.bind(runner);
    runner.run = async (spec) => {
      const result = await originalRun(spec);
      if (spec.args[0] !== 'container') return result;
      return {
        ...result,
        stdout: result.stdout.replace('127.0.0.1', '0.0.0.0'),
      };
    };
    await expect(
      new Nf04DockerInspector(runner).inspectRecorded(
        {
          observed: {
            sourceContainer: { id: 'source-container-object-id' },
            sourceVolume: { name: 'mh_nf04_a1b2c3d4_src_data' },
            network: { id: 'network-object-id' },
          },
        } as never,
        'source',
      ),
    ).rejects.toThrow(/loopback/i);
  });
});
