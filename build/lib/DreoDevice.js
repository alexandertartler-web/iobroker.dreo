"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DreoDevice = void 0;
const ONLINE_KEYS = ["online", "isOnline", "available", "connected", "status"];
class DreoDevice {
    info;
    client;
    rawState = {};
    properties = {};
    constructor(rawDevice, client) {
        this.client = client;
        this.info = DreoDevice.normalizeDevice(rawDevice);
    }
    static normalizeDevice(raw) {
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
    get isHeaterLike() {
        const haystack = [this.info.type, this.info.model, this.info.productName, this.info.productId].filter(Boolean).join(" ").toLowerCase();
        return /heater|hsh|wh714|oh521/.test(haystack);
    }
    async refresh() {
        this.rawState = await this.client.getDeviceState(this.info.serialNumber);
        this.properties = this.extractProperties(this.rawState);
    }
    getRawState() {
        return this.rawState;
    }
    getProperties() {
        return this.properties;
    }
    applyReportedUpdate(reported) {
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
    getOnline() {
        return DreoDevice.extractOnline(this.rawState) ?? DreoDevice.extractOnline(this.properties) ?? this.info.online;
    }
    getCommonStates() {
        return {
            "info.name": this.info.name ?? null,
            "info.model": this.info.model ?? null,
            "info.deviceId": this.info.deviceId ?? this.info.serialNumber,
            "info.online": this.getOnline() ?? null,
            "info.rawData": this.safeRawPayload(),
            "status.power": this.getStateValue("poweron"),
        };
    }
    supportsControl(control) {
        if (control === "power")
            return true;
        return false;
    }
    async setControl(control, value) {
        if (control === "power") {
            return await this.sendCommand({ poweron: this.toBoolean(value) });
        }
        throw new Error(`Unsupported Dreo control: ${control}`);
    }
    async sendCommand(desired) {
        return await this.client.updateDeviceState(this.info.serialNumber, desired);
    }
    getStateValue(key) {
        const value = this.properties[key];
        if (value && typeof value === "object" && !Array.isArray(value) && "state" in value) {
            return value.state;
        }
        return value ?? null;
    }
    extractProperties(payload) {
        for (const key of ["state", "status", "properties", "reported", "desired"]) {
            const value = payload[key];
            if (value && typeof value === "object" && !Array.isArray(value))
                return { ...value };
        }
        return { ...payload };
    }
    toBoolean(value) {
        if (typeof value === "boolean")
            return value;
        if (typeof value === "number")
            return value !== 0;
        if (typeof value === "string")
            return ["true", "1", "on", "yes"].includes(value.toLowerCase());
        return !!value;
    }
    safeRawPayload() {
        try {
            return JSON.stringify({ device: this.info.raw, state: this.rawState });
        }
        catch {
            return "{}";
        }
    }
    static firstString(payload, ...keys) {
        for (const key of keys) {
            const value = payload[key];
            if (value !== undefined && value !== null && value !== "")
                return String(value);
        }
        return undefined;
    }
    static extractOnline(payload) {
        for (const key of ONLINE_KEYS) {
            if (!(key in payload))
                continue;
            const value = payload[key];
            if (typeof value === "boolean")
                return value;
            if (typeof value === "number")
                return value !== 0;
            if (typeof value === "string") {
                const normalized = value.toLowerCase();
                if (["online", "connected", "available", "true", "1"].includes(normalized))
                    return true;
                if (["offline", "disconnected", "unavailable", "false", "0"].includes(normalized))
                    return false;
            }
        }
        return undefined;
    }
}
exports.DreoDevice = DreoDevice;
//# sourceMappingURL=DreoDevice.js.map