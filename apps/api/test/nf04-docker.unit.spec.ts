import { resolve } from 'node:path';
import { assertLiveNf04DockerEvidence, Nf04DockerInspector } from '../src/nf04/nf04-docker';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';

type TestPortBindings = Record<string, Array<{ HostIp: string; HostPort: string }> | null>;

class DockerInspectRunner implements Nf04ProcessRunner {
  readonly calls: Nf04ProcessSpec[] = [];

  constructor(private readonly containerRecord = makeContainerRecord()) {}

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    const kind = spec.args[0];
    const stdout =
      kind === 'container'
        ? JSON.stringify([this.containerRecord])
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
  it('separates created configuration evidence from running runtime evidence', async () => {
    const configured = makeContainerRecord();
    configured.State = { Status: 'created', Running: false };
    configured.NetworkSettings.Ports = {};
    const inspector = new Nf04DockerInspector(new DockerInspectRunner(configured));

    await expect(
      inspector.inspectConfiguredContainer('source-container-object-id'),
    ).resolves.toMatchObject({ hostPort: 55431 });

    await expect(
      new Nf04DockerInspector(
        new DockerInspectRunner(makeContainerRecord()),
      ).inspectConfiguredContainer('source-container-object-id'),
    ).rejects.toThrow(/created state/i);
  });

  it('uses recorded IDs and compares the complete running identity', async () => {
    const runner = new DockerInspectRunner();
    const inspector = new Nf04DockerInspector(runner);
    const manifest = completeRecordedManifest();
    const live = await inspector.inspectRecorded(manifest as never, 'source', undefined, 'running');

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
  });

  it('rejects non-loopback runtime evidence', async () => {
    const record = makeContainerRecord();
    record.NetworkSettings.Ports['5432/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '55431' }];

    await expect(
      new Nf04DockerInspector(new DockerInspectRunner(record)).inspectRecorded(
        minimalRecordedManifest() as never,
        'source',
      ),
    ).rejects.toThrow(/loopback/i);

    const missing = makeContainerRecord();
    missing.NetworkSettings.Ports = {};
    await expect(
      new Nf04DockerInspector(new DockerInspectRunner(missing)).inspectRecorded(
        minimalRecordedManifest() as never,
        'source',
        undefined,
        'running',
      ),
    ).rejects.toThrow(/loopback/i);
  });

  it('rejects missing, multiple, non-loopback, or malformed configured bindings', async () => {
    const invalidBindings = [
      {},
      {
        '5432/tcp': [
          { HostIp: '127.0.0.1', HostPort: '55431' },
          { HostIp: '127.0.0.1', HostPort: '55432' },
        ],
      },
      { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55431' }] },
      { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: 'not-a-port' }] },
    ];

    for (const PortBindings of invalidBindings) {
      const record = makeContainerRecord();
      record.State = { Status: 'created', Running: false };
      record.HostConfig.PortBindings = PortBindings;
      await expect(
        new Nf04DockerInspector(new DockerInspectRunner(record)).inspectConfiguredContainer(
          'source-container-object-id',
        ),
      ).rejects.toThrow(/loopback|host port/i);
    }
  });

  it('requires running or stopped state without treating configured ports as runtime evidence', async () => {
    const created = makeContainerRecord();
    created.State = { Status: 'created', Running: false };
    created.NetworkSettings.Ports = {};
    await expect(
      new Nf04DockerInspector(new DockerInspectRunner(created)).inspectRecorded(
        minimalRecordedManifest() as never,
        'source',
        undefined,
        'running',
      ),
    ).rejects.toThrow(/running state/i);

    const stopped = makeContainerRecord();
    stopped.State = { Status: 'exited', Running: false };
    stopped.NetworkSettings.Ports = {};
    await expect(
      new Nf04DockerInspector(new DockerInspectRunner(stopped)).inspectRecorded(
        minimalRecordedManifest() as never,
        'source',
        undefined,
        'stopped',
      ),
    ).resolves.toMatchObject({ container: { hostPort: 55431 } });
  });
});

function makeContainerRecord(): {
  Id: string;
  Name: string;
  Image: string;
  State: { Status: string; Running: boolean };
  Config: { Image: string; Labels: Record<string, string> };
  HostConfig: { PortBindings: TestPortBindings };
  Mounts: Array<{
    Type: 'bind' | 'volume';
    Name?: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }>;
  NetworkSettings: { Ports: TestPortBindings; Networks: Record<string, object> };
} {
  return {
    Id: 'source-container-object-id',
    Name: '/mh-nf04-20260913-143000-a1b2c3d4-src',
    Image: `sha256:${'a'.repeat(64)}`,
    State: { Status: 'running', Running: true },
    Config: {
      Image: 'postgres:18.6-alpine',
      Labels: {
        'mh.nf04.run': '20260913-143000-a1b2c3d4',
        'mh.nf04.role': 'source',
      },
    },
    HostConfig: {
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55431' }] },
    },
    Mounts: [
      {
        Type: 'volume' as const,
        Name: 'mh_nf04_a1b2c3d4_src_data',
        Source: '/docker/source',
        Destination: '/var/lib/postgresql/18/docker',
        RW: true,
      },
      {
        Type: 'bind' as const,
        Source: resolve('E:/study-project/handoff/nf04-backup-restore/run'),
        Destination: '/nf04-output',
        RW: true,
      },
    ],
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55431' }] },
      Networks: { mh_nf04_a1b2c3d4_network: {} },
    },
  };
}

function minimalRecordedManifest() {
  return {
    observed: {
      sourceContainer: { id: 'source-container-object-id' },
      sourceVolume: { name: 'mh_nf04_a1b2c3d4_src_data' },
      network: { id: 'network-object-id' },
    },
  };
}

function completeRecordedManifest() {
  const record = makeContainerRecord();
  return {
    observed: {
      sourceContainer: {
        id: record.Id,
        name: record.Name.slice(1),
        imageId: record.Image,
        imageReference: record.Config.Image as 'postgres:18.6-alpine',
        labels: record.Config.Labels,
        mounts: record.Mounts.map((mount) => ({
          type: mount.Type,
          source: mount.Source,
          destination: mount.Destination,
          readWrite: mount.RW,
          ...('Name' in mount ? { volumeName: mount.Name } : {}),
        })),
        networkNames: Object.keys(record.NetworkSettings.Networks),
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
}
