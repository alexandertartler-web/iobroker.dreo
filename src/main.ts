import * as utils from "@iobroker/adapter-core";
import { DreoApiError, DreoClient, DreoLogger, DreoRawDevice } from "./lib/DreoClient";
import { DreoDevice } from "./lib/DreoDevice";
import { DreoHeater, HEATER_MODES } from "./lib/DreoHeater";

type AdapterConfig = {
  email?: string;
  password?: string;
  pollingInterval?: number;
  deviceFilter?: string;
  debugMode?: boolean;
};

type ManagedDevice = {
  path: string;
  device: DreoDevice;
};

class DreoAdapter extends utils.Adapter {
  private client?: DreoClient;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private polling = false;
  private retryAttempt = 0;
  private readonly managedDevices = new Map<string, ManagedDevice>();
  private readonly devicePathBySerial = new Map<string, string>();

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "dreo",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  private async onReady(): Promise<void> {
    const config = this.config as AdapterConfig;
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Cloud connection",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setStateAsync("info.connection", false, true);

    if (!config.email || !config.password) {
      this.log.warn("Dreo email/password are not configured. Adapter will stay idle.");
      return;
    }

    this.client = new DreoClient({
      email: config.email,
      password: config.password,
      logger: this.clientLogger(),
      debugMode: !!config.debugMode,
      onLegacyMessage: (message) => void this.onDreoRealtimeMessage(message),
    });

    this.subscribeStates("devices.*.control.*");
    await this.pollNow();
  }

  private async pollNow(): Promise<void> {
    if (this.stopped || this.polling || !this.client) return;
    this.polling = true;

    try {
      const rawDevices = this.filterDevices(await this.client.getDevices());

      for (const rawDevice of rawDevices) {
        const device = this.createDreoDevice(rawDevice);
        const path = `devices.${this.sanitizeId(device.info.id)}`;
        this.managedDevices.set(path, { path, device });
        this.devicePathBySerial.set(device.info.serialNumber, path);

        await device.refresh();
        await this.createDeviceObjects(path, device);
        await this.writeDeviceStates(path, device);

        if ((this.config as AdapterConfig).debugMode) {
          this.log.debug(`Updated ${device.info.name ?? device.info.id}: ${JSON.stringify(device.getProperties())}`);
        }
      }

      if (!rawDevices.length) {
        this.log.warn("No Dreo devices were returned by the cloud API. Check account, region, and optional device filter.");
      }

      await this.setStateAsync("info.connection", true, true);
      this.retryAttempt = 0;
      this.scheduleNextPoll();
    } catch (error) {
      await this.setStateAsync("info.connection", false, true);
      this.log.error(this.formatError("Dreo polling failed", error));
      this.scheduleRetry(error);
    } finally {
      this.polling = false;
    }
  }

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state || state.ack || this.stopped || !this.client) return;

    const prefix = `${this.namespace}.devices.`;
    if (!id.startsWith(prefix)) return;
    const parts = id.slice(prefix.length).split(".");
    if (parts.length !== 3 || parts[1] !== "control") return;

    const devicePath = `devices.${parts[0]}`;
    const control = parts[2];
    const managed = this.managedDevices.get(devicePath);
    if (!managed) {
      this.log.warn(`Ignoring control.${control}: no managed Dreo device found for ${devicePath}`);
      return;
    }

    try {
      if (!managed.device.supportsControl(control)) {
        this.log.warn(`Device ${managed.device.info.name ?? managed.device.info.id} does not support control.${control}`);
        await this.setStateChangedAsync(`${devicePath}.control.${control}`, state.val, true);
        return;
      }

      await managed.device.setControl(control, state.val);
      await this.setStateChangedAsync(`${devicePath}.control.${control}`, state.val, true);
      await managed.device.refresh();
      await this.writeDeviceStates(devicePath, managed.device);
    } catch (error) {
      this.log.error(this.formatError(`Failed to send Dreo command ${control} for ${managed.device.info.id}`, error));
      await this.setStateChangedAsync(`${devicePath}.control.${control}`, state.val, true);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      this.stopped = true;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
      this.client?.stop();
      callback();
    } catch {
      callback();
    }
  }

  private async onDreoRealtimeMessage(message: Record<string, any>): Promise<void> {
    const deviceSn = typeof message.devicesn === "string" ? message.devicesn : undefined;
    const reported = message.reported && typeof message.reported === "object" && !Array.isArray(message.reported) ? message.reported as Record<string, any> : undefined;
    if (!deviceSn || !reported) return;

    const path = this.devicePathBySerial.get(deviceSn);
    if (!path) {
      if ((this.config as AdapterConfig).debugMode) this.log.debug(`Ignoring Dreo realtime update for unknown device ${deviceSn}`);
      return;
    }

    const managed = this.managedDevices.get(path);
    if (!managed) return;
    managed.device.applyReportedUpdate(reported);
    await this.writeDeviceStates(path, managed.device);
  }

  private createDreoDevice(rawDevice: DreoRawDevice): DreoDevice {
    const normalized = DreoDevice.normalizeDevice(rawDevice);
    const candidate = new DreoDevice(rawDevice, this.client!);
    if (candidate.isHeaterLike) return new DreoHeater(rawDevice, this.client!);
    this.log.info(`Unknown or not yet specialized Dreo device detected: ${normalized.name ?? normalized.id}. It will be exposed with generic states and rawData.`);
    return candidate;
  }

  private filterDevices(devices: DreoRawDevice[]): DreoRawDevice[] {
    const filters = String((this.config as AdapterConfig).deviceFilter ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (!filters.length) return devices;

    return devices.filter((raw) => {
      const info = DreoDevice.normalizeDevice(raw);
      const candidates = [info.id, info.serialNumber, info.deviceId, info.name, info.model].filter(Boolean).map((item) => String(item).toLowerCase());
      return filters.some((filter) => candidates.includes(filter));
    });
  }

  private async createDeviceObjects(path: string, device: DreoDevice): Promise<void> {
    await this.setObjectNotExistsAsync(path, {
      type: "device",
      common: {
        name: device.info.name ?? device.info.id,
      },
      native: device.info.raw,
    });

    await this.ensureChannel(`${path}.info`, "Info");
    await this.ensureChannel(`${path}.status`, "Status");
    await this.ensureChannel(`${path}.control`, "Control");

    await this.ensureState(`${path}.info.name`, "Name", "string", "text", false);
    await this.ensureState(`${path}.info.model`, "Model", "string", "text", false);
    await this.ensureState(`${path}.info.deviceId`, "Device ID", "string", "text", false);
    await this.ensureState(`${path}.info.online`, "Online", "boolean", "indicator.connected", false);
    await this.ensureState(`${path}.info.rawData`, "Raw API data", "string", "json", false);

    await this.ensureState(`${path}.status.power`, "Power", "boolean", "switch.power", false);
    await this.ensureState(`${path}.status.currentTemperature`, "Current temperature", "number", "value.temperature", false, "°");
    await this.ensureState(`${path}.status.targetTemperature`, "Target temperature", "number", "level.temperature", false, "°");
    await this.ensureState(`${path}.status.mode`, "Mode", "string", "text", false);
    await this.ensureState(`${path}.status.fanSpeed`, "Fan speed / heat level", "number", "level", false);
    await this.ensureState(`${path}.status.oscillation`, "Oscillation", "mixed", "state", false);
    await this.ensureState(`${path}.status.timer`, "Timer", "number", "value.interval", false, "min");

    await this.ensureState(`${path}.control.power`, "Power", "boolean", "switch.power", true);
    await this.ensureState(`${path}.control.targetTemperature`, "Target temperature", "number", "level.temperature", true, "°");
    await this.ensureState(`${path}.control.mode`, "Mode", "string", "text", true, undefined, HEATER_MODES as unknown as string[]);
    await this.ensureState(`${path}.control.fanSpeed`, "Fan speed / heat level", "number", "level", true);
    await this.ensureState(`${path}.control.oscillation`, "Oscillation", "mixed", "state", true);
  }

  private async writeDeviceStates(path: string, device: DreoDevice): Promise<void> {
    const states = device.getCommonStates();
    for (const [relativeId, value] of Object.entries(states)) {
      await this.setStateChangedAsync(`${path}.${relativeId}`, value as ioBroker.StateValue, true);
    }

    await this.mirrorStatusToControl(path, "power", states["status.power"]);
    await this.mirrorStatusToControl(path, "targetTemperature", states["status.targetTemperature"]);
    await this.mirrorStatusToControl(path, "mode", states["status.mode"]);
    await this.mirrorStatusToControl(path, "fanSpeed", states["status.fanSpeed"]);
    await this.mirrorStatusToControl(path, "oscillation", states["status.oscillation"]);
  }

  private async mirrorStatusToControl(path: string, control: string, value: any): Promise<void> {
    if (value === undefined || value === null) return;
    await this.setStateChangedAsync(`${path}.control.${control}`, value as ioBroker.StateValue, true);
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    const intervalSeconds = Math.max(15, Number((this.config as AdapterConfig).pollingInterval) || 60);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollNow(), intervalSeconds * 1000);
  }

  private scheduleRetry(error: unknown): void {
    if (this.stopped) return;
    this.retryAttempt += 1;
    const retryable = error instanceof DreoApiError ? error.retryable || error.authError : true;
    const baseDelay = retryable ? 5 : 60;
    const delaySeconds = Math.min(300, baseDelay * 2 ** Math.min(this.retryAttempt, 6));
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.log.warn(`Retrying Dreo polling in ${delaySeconds} seconds`);
    this.pollTimer = setTimeout(() => void this.pollNow(), delaySeconds * 1000);
  }

  private async ensureChannel(id: string, name: string): Promise<void> {
    await this.setObjectNotExistsAsync(id, {
      type: "channel",
      common: { name },
      native: {},
    });
  }

  private async ensureState(id: string, name: string, type: ioBroker.CommonType | "mixed", role: string, write: boolean, unit?: string, states?: any): Promise<void> {
    await this.setObjectNotExistsAsync(id, {
      type: "state",
      common: {
        name,
        type,
        role,
        read: true,
        write,
        unit,
        states,
      },
      native: {},
    });
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private clientLogger(): DreoLogger {
    return {
      debug: (message) => this.log.debug(message),
      info: (message) => this.log.info(message),
      warn: (message) => this.log.warn(message),
      error: (message) => this.log.error(message),
    };
  }

  private formatError(prefix: string, error: unknown): string {
    if (error instanceof DreoApiError) {
      return `${prefix}: ${error.message}${error.status ? ` (HTTP ${error.status})` : ""}${error.code ? ` (code ${error.code})` : ""}`;
    }
    if (error instanceof Error) return `${prefix}: ${error.message}`;
    return `${prefix}: ${String(error)}`;
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new DreoAdapter(options);
} else {
  void new DreoAdapter();
}
