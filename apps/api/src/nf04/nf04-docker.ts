import { z } from 'zod';
import type { Nf04Manifest } from './nf04-contract';
import { Nf04GuardError } from './nf04-guards';
import type { Nf04ProcessRunner } from './nf04-process';

export type Nf04ContainerEvidence = NonNullable<Nf04Manifest['observed']['sourceContainer']>;
export type Nf04VolumeEvidence = NonNullable<Nf04Manifest['observed']['sourceVolume']>;
export type Nf04NetworkEvidence = NonNullable<Nf04Manifest['observed']['network']>;

const containerInspectSchema = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      Image: z.string(),
      Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()).nullable() }),
      Mounts: z.array(
        z.object({
          Type: z.enum(['bind', 'volume']),
          Source: z.string(),
          Destination: z.string(),
          RW: z.boolean(),
          Name: z.string().optional(),
        }),
      ),
      NetworkSettings: z.object({
        Ports: z.record(
          z.string(),
          z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable(),
        ),
        Networks: z.record(z.string(), z.unknown()),
      }),
    }),
  )
  .length(1);

const volumeInspectSchema = z
  .array(
    z.object({
      Name: z.string(),
      Driver: z.string(),
      Mountpoint: z.string(),
      Labels: z.record(z.string(), z.string()).nullable(),
    }),
  )
  .length(1);

const networkInspectSchema = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      Driver: z.string(),
      Labels: z.record(z.string(), z.string()).nullable(),
    }),
  )
  .length(1);

export class Nf04DockerInspector {
  constructor(private readonly runner: Nf04ProcessRunner) {}

  async inspectRecorded(
    manifest: Nf04Manifest,
    role: 'source' | 'restore',
    signal?: AbortSignal,
  ): Promise<{
    container: Nf04ContainerEvidence;
    volume: Nf04VolumeEvidence;
    network: Nf04NetworkEvidence;
  }> {
    const recordedContainer =
      role === 'source' ? manifest.observed.sourceContainer : manifest.observed.restoreContainer;
    const recordedVolume =
      role === 'source' ? manifest.observed.sourceVolume : manifest.observed.restoreVolume;
    const recordedNetwork = manifest.observed.network;
    if (!recordedContainer || !recordedVolume || !recordedNetwork) {
      throw new Nf04GuardError('Recorded Docker evidence is incomplete');
    }
    const [container, volume, network] = await Promise.all([
      this.inspectContainer(recordedContainer.id, signal),
      this.inspectVolume(recordedVolume.name, signal),
      this.inspectNetwork(recordedNetwork.id, signal),
    ]);
    return { container, volume, network };
  }

  private async inspectContainer(id: string, signal?: AbortSignal): Promise<Nf04ContainerEvidence> {
    const output = await this.inspect(['container', 'inspect', id], signal);
    const record = containerInspectSchema.parse(JSON.parse(output))[0]!;
    const binding = record.NetworkSettings.Ports['5432/tcp'];
    if (!binding || binding.length !== 1 || binding[0]?.HostIp !== '127.0.0.1') {
      throw new Nf04GuardError('NF-04 PostgreSQL port must have one loopback-only binding');
    }
    const hostPort = Number(binding[0].HostPort);
    if (!Number.isInteger(hostPort)) throw new Nf04GuardError('Invalid Docker host port evidence');
    return {
      id: record.Id,
      name: record.Name.replace(/^\//, ''),
      imageId: record.Image,
      imageReference: record.Config.Image as Nf04ContainerEvidence['imageReference'],
      labels: record.Config.Labels ?? {},
      mounts: record.Mounts.map((mount) => ({
        type: mount.Type,
        source: mount.Source,
        destination: mount.Destination,
        readWrite: mount.RW,
        ...(mount.Name ? { volumeName: mount.Name } : {}),
      })),
      networkNames: Object.keys(record.NetworkSettings.Networks),
      hostPort,
    };
  }

  private async inspectVolume(name: string, signal?: AbortSignal): Promise<Nf04VolumeEvidence> {
    const output = await this.inspect(['volume', 'inspect', name], signal);
    const record = volumeInspectSchema.parse(JSON.parse(output))[0]!;
    return {
      name: record.Name,
      driver: record.Driver,
      mountpoint: record.Mountpoint,
      labels: record.Labels ?? {},
    };
  }

  private async inspectNetwork(id: string, signal?: AbortSignal): Promise<Nf04NetworkEvidence> {
    const output = await this.inspect(['network', 'inspect', id], signal);
    const record = networkInspectSchema.parse(JSON.parse(output))[0]!;
    return {
      id: record.Id,
      name: record.Name,
      driver: record.Driver,
      labels: record.Labels ?? {},
    };
  }

  private async inspect(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await this.runner.run({
      executable: 'docker',
      args,
      timeoutMs: 10_000,
      ...(signal ? { signal } : {}),
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Nf04GuardError('Exact Docker resource inspection failed');
    }
    return result.stdout;
  }
}

export function assertLiveNf04DockerEvidence(
  recorded: {
    container: Nf04ContainerEvidence;
    volume: Nf04VolumeEvidence;
    network: Nf04NetworkEvidence;
  },
  live: {
    container: Nf04ContainerEvidence;
    volume: Nf04VolumeEvidence;
    network: Nf04NetworkEvidence;
  },
): void {
  const comparable = (value: unknown) => JSON.stringify(value, objectKeySort);
  if (
    comparable(recorded.container) !== comparable(live.container) ||
    comparable(recorded.volume) !== comparable(live.volume) ||
    comparable(recorded.network) !== comparable(live.network)
  ) {
    throw new Nf04GuardError('Live Docker evidence does not match the recorded exact resources');
  }
}

function objectKeySort(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  }
  if (Array.isArray(value)) {
    return [...value].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  return value;
}
