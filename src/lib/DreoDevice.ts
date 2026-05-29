import { DreoClient, DreoRawDevice, DreoRawState } from "./DreoClient";

export type DeviceStateValue = string | number | boolean | null | Record<string, any> | Array<any>;

export type NormalizedDreoDevice = {
  id: string;
  serialNumber: string;
  deviceId?: string;
  name?: string;
  model?: string;
  productName?: string;
  productId?: string;
  type?: string;
  online?: boolean;
  raw: DreoRawDevice;
};

const ONLINE_KEYS = ["online", "isOnline", "available", "connected", "status"];

export class DreoDevice {
  public readonly info: NormalizedDreoDevice;
  protected readonly client: DreoClient;
  protected rawState: DreoRawState = {};
  protected properties: Record<string, any> = {};

  public constructor(rawDevice: DreoRawDevice, client: DreoClient) {
    this.client = client;
    this.info = DreoDevice.normalizeDevice(rawDevice);
  }

  public static normalizeDevice(raw: DreoRawDevice): NormalizedDreoDevice {
    const serialNumber = DreoDevice.firstString(raw, "deviceSn", "devicesn", "serialNumber", "serial_number", "sn") ?? "";
    const deviceId = DreoDevice.firstString(raw, "deviceId", "device_id", "id");
    const id = serialNumber || deviceId || DreoDevice.firstString(raw, "mac", "macAddress", "name", "deviceName") || "unknown";

    return {
      id,
      serialNumber: serialNumber || id,
      deviceId,
      name: DreoDevice.firstString(raw, "deviceName", "name", "nickname", "alias"),
      model: DreoDevice.firstString(raw, "model", "deviceModel", "productName"),
      productName: DreoDevice.firstString(raw, "productName"),
      productId: DreoDevice.firstString(raw, "productId", "product_id", "productType", "sku"),
      type: DreoDevice.firstString(raw, "type", "category", "deviceType", "productName"),
      online: DreoDevice.extractOnline(raw),
      raw,
    };
  }

  public get isHeaterLike(): boolean {
    const haystack = [this.info.type, this.info.model, this.info.productName, this.info.productId].filter(Boolean).join(" ").toLowerCase();
    return /heater|hsh|wh714|oh521/.test(haystack);
  }

  public async refresh(): Promise<void> {
    this.rawState = await this.client.getDeviceState(this.info.serialNumber);
    this.properties = this.extractProperties(this.rawState);
  }

  public getRawState(): DreoRawState {
    return this.rawState;
  }

  public getProperties(): Record<string, any> {
    return this.properties;
  }

  public applyReportedUpdate(reported: Record<string, any>): void {
    this.properties = {
      ...this.properties,
      ...reported,
    };
    this.rawState = {
      ...this.rawState,
      reported: {
        ...(this.rawState.reported && typeof this.rawState.reported === "object" ? this.rawState.reported : {}),
        ...reported,
      },
    };
  }

  public getOnline(): boolean | undefined {
    return DreoDevice.extractOnline(this.rawState) ?? DreoDevice.extractOnline(this.properties) ?? this.info.online;
  }

  public getCommonStates(): Record<string, DeviceStateValue> {
    return {
      "info.name": this.info.name ?? null,
      "info.model": this.info.model ?? null,
      "info.deviceId": this.info.deviceId ?? this.info.serialNumber,
      "info.online": this.getOnline() ?? null,
      "info.rawData": this.safeRawPayload(),
      "status.power": this.getStateValue("poweron"),
    };
  }

  public supportsControl(control: string): boolean {
    if (control === "power") return true;
    return false;
  }

  public async setControl(control: string, value: any): Promise<Record<string, any>> {
    if (control === "power") {
      return await this.sendCommand({ poweron: this.toBoolean(value) });
    }
    throw new Error(`Unsupported Dreo control: ${control}`);
  }

  public async sendCommand(desired: Record<string, any>): Promise<Record<string, any>> {
    return await this.client.updateDeviceState(this.info.serialNumber, desired);
  }

  protected getStateValue(key: string): any {
    const value = this.properties[key];
    if (value && typeof value === "object" && !Array.isArray(value) && "state" in value) {
      return value.state;
    }
    return value ?? null;
  }

  protected extractProperties(payload: DreoRawState): Record<string, any> {
    for (const key of ["state", "status", "properties", "reported", "desired"]) {
      const value = payload[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
    }
    return { ...payload };
  }

  protected toBoolean(value: any): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return ["true", "1", "on", "yes"].includes(value.toLowerCase());
    return !!value;
  }

  private safeRawPayload(): string {
    try {
      return JSON.stringify({ device: this.info.raw, state: this.rawState });
    } catch {
      return "{}";
    }
  }

  private static firstString(payload: Record<string, any>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (value !== undefined && value !== null && value !== "") return String(value);
    }
    return undefined;
  }

  private static extractOnline(payload: Record<string, any>): boolean | undefined {
    for (const key of ONLINE_KEYS) {
      if (!(key in payload)) continue;
      const value = payload[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        const normalized = value.toLowerCase();
        if (["online", "connected", "available", "true", "1"].includes(normalized)) return true;
        if (["offline", "disconnected", "unavailable", "false", "0"].includes(normalized)) return false;
      }
    }
    return undefined;
  }
}
