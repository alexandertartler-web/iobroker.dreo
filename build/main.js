"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const DreoClient_1 = require("./lib/DreoClient");
const DreoDevice_1 = require("./lib/DreoDevice");
const DreoHeater_1 = require("./lib/DreoHeater");
class DreoAdapter extends utils.Adapter {
    client;
    pollTimer;
    stopped = false;
    polling = false;
    retryAttempt = 0;
    managedDevices = new Map();
    devicePathBySerial = new Map();
    constructor(options = {}) {
        super({
            ...options,
            name: "dreo",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    async onReady() {
        const config = this.config;
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
        this.client = new DreoClient_1.DreoClient({
            email: config.email,
            password: config.password,
            logger: this.clientLogger(),
            debugMode: !!config.debugMode,
            onLegacyMessage: (message) => void this.onDreoRealtimeMessage(message),
        });
        this.subscribeStates("devices.*.control.*");
        await this.pollNow();
    }
    async pollNow() {
        if (this.stopped || this.polling || !this.client)
            return;
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
                if (this.config.debugMode) {
                    this.log.debug(`Updated ${device.info.name ?? device.info.id}: ${JSON.stringify(device.getProperties())}`);
                }
            }
            if (!rawDevices.length) {
                this.log.warn("No Dreo devices were returned by the cloud API. Check account, region, and optional device filter.");
            }
            await this.setStateAsync("info.connection", true, true);
            this.retryAttempt = 0;
            this.scheduleNextPoll();
        }
        catch (error) {
            await this.setStateAsync("info.connection", false, true);
            this.log.error(this.formatError("Dreo polling failed", error));
            this.scheduleRetry(error);
        }
        finally {
            this.polling = false;
        }
    }
    async onStateChange(id, state) {
        if (!state || state.ack || this.stopped || !this.client)
            return;
        const prefix = `${this.namespace}.devices.`;
        if (!id.startsWith(prefix))
            return;
        const parts = id.slice(prefix.length).split(".");
        if (parts.length !== 3 || parts[1] !== "control")
            return;
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
        }
        catch (error) {
            this.log.error(this.formatError(`Failed to send Dreo command ${control} for ${managed.device.info.id}`, error));
            await this.setStateChangedAsync(`${devicePath}.control.${control}`, state.val, true);
        }
    }
    onUnload(callback) {
        try {
            this.stopped = true;
            if (this.pollTimer) {
                clearTimeout(this.pollTimer);
                this.pollTimer = undefined;
            }
            this.client?.stop();
            callback();
        }
        catch {
            callback();
        }
    }
    async onDreoRealtimeMessage(message) {
        const deviceSn = typeof message.devicesn === "string" ? message.devicesn : undefined;
        const reported = message.reported && typeof message.reported === "object" && !Array.isArray(message.reported) ? message.reported : undefined;
        if (!deviceSn || !reported)
            return;
        const path = this.devicePathBySerial.get(deviceSn);
        if (!path) {
            if (this.config.debugMode)
                this.log.debug(`Ignoring Dreo realtime update for unknown device ${deviceSn}`);
            return;
        }
        const managed = this.managedDevices.get(path);
        if (!managed)
            return;
        managed.device.applyReportedUpdate(reported);
        await this.writeDeviceStates(path, managed.device);
    }
    createDreoDevice(rawDevice) {
        const normalized = DreoDevice_1.DreoDevice.normalizeDevice(rawDevice);
        const candidate = new DreoDevice_1.DreoDevice(rawDevice, this.client);
        if (candidate.isHeaterLike)
            return new DreoHeater_1.DreoHeater(rawDevice, this.client);
        this.log.info(`Unknown or not yet specialized Dreo device detected: ${normalized.name ?? normalized.id}. It will be exposed with generic states and rawData.`);
        return candidate;
    }
    filterDevices(devices) {
        const filters = String(this.config.deviceFilter ?? "")
            .split(",")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean);
        if (!filters.length)
            return devices;
        return devices.filter((raw) => {
            const info = DreoDevice_1.DreoDevice.normalizeDevice(raw);
            const candidates = [info.id, info.serialNumber, info.deviceId, info.name, info.model].filter(Boolean).map((item) => String(item).toLowerCase());
            return filters.some((filter) => candidates.includes(filter));
        });
    }
    async createDeviceObjects(path, device) {
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
        await this.ensureState(`${path}.control.mode`, "Mode", "string", "text", true, undefined, DreoHeater_1.HEATER_MODES);
        await this.ensureState(`${path}.control.fanSpeed`, "Fan speed / heat level", "number", "level", true);
        await this.ensureState(`${path}.control.oscillation`, "Oscillation", "mixed", "state", true);
    }
    async writeDeviceStates(path, device) {
        const states = device.getCommonStates();
        for (const [relativeId, value] of Object.entries(states)) {
            await this.setStateChangedAsync(`${path}.${relativeId}`, value, true);
        }
        await this.mirrorStatusToControl(path, "power", states["status.power"]);
        await this.mirrorStatusToControl(path, "targetTemperature", states["status.targetTemperature"]);
        await this.mirrorStatusToControl(path, "mode", states["status.mode"]);
        await this.mirrorStatusToControl(path, "fanSpeed", states["status.fanSpeed"]);
        await this.mirrorStatusToControl(path, "oscillation", states["status.oscillation"]);
    }
    async mirrorStatusToControl(path, control, value) {
        if (value === undefined || value === null)
            return;
        await this.setStateChangedAsync(`${path}.control.${control}`, value, true);
    }
    scheduleNextPoll() {
        if (this.stopped)
            return;
        const intervalSeconds = Math.max(15, Number(this.config.pollingInterval) || 60);
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => void this.pollNow(), intervalSeconds * 1000);
    }
    scheduleRetry(error) {
        if (this.stopped)
            return;
        this.retryAttempt += 1;
        const retryable = error instanceof DreoClient_1.DreoApiError ? error.retryable || error.authError : true;
        const baseDelay = retryable ? 5 : 60;
        const delaySeconds = Math.min(300, baseDelay * 2 ** Math.min(this.retryAttempt, 6));
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.log.warn(`Retrying Dreo polling in ${delaySeconds} seconds`);
        this.pollTimer = setTimeout(() => void this.pollNow(), delaySeconds * 1000);
    }
    async ensureChannel(id, name) {
        await this.setObjectNotExistsAsync(id, {
            type: "channel",
            common: { name },
            native: {},
        });
    }
    async ensureState(id, name, type, role, write, unit, states) {
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
    sanitizeId(id) {
        return id.replace(/[^a-zA-Z0-9_-]/g, "_");
    }
    clientLogger() {
        return {
            debug: (message) => this.log.debug(message),
            info: (message) => this.log.info(message),
            warn: (message) => this.log.warn(message),
            error: (message) => this.log.error(message),
        };
    }
    formatError(prefix, error) {
        if (error instanceof DreoClient_1.DreoApiError) {
            return `${prefix}: ${error.message}${error.status ? ` (HTTP ${error.status})` : ""}${error.code ? ` (code ${error.code})` : ""}`;
        }
        if (error instanceof Error)
            return `${prefix}: ${error.message}`;
        return `${prefix}: ${String(error)}`;
    }
}
if (require.main !== module) {
    module.exports = (options) => new DreoAdapter(options);
}
else {
    void new DreoAdapter();
}
//# sourceMappingURL=main.js.map