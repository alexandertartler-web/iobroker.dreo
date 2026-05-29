import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import crypto from "node:crypto";
import WebSocket from "ws";

export type DreoLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type DreoRawDevice = Record<string, any>;
export type DreoRawState = Record<string, any>;

export class DreoApiError extends Error {
  public readonly code?: number | string;
  public readonly status?: number;
  public readonly retryable: boolean;
  public readonly authError: boolean;

  public constructor(message: string, options: { code?: number | string; status?: number; retryable?: boolean; authError?: boolean } = {}) {
    super(message);
    this.name = "DreoApiError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.authError = options.authError ?? false;
  }
}

type LoginResponse = {
  access_token?: string;
  token?: string;
  endpoint?: string;
  region?: string;
};

type DreoClientOptions = {
  email: string;
  password: string;
  logger: DreoLogger;
  debugMode?: boolean;
  timeoutMs?: number;
  onLegacyMessage?: (message: Record<string, any>) => void | Promise<void>;
};

const BASE_URL = "https://open-api-us.dreo-tech.com";
const EU_BASE_URL = "https://open-api-eu.dreo-tech.com";
const LEGACY_URL = "https://app-api-us.dreo-tech.com";
const LEGACY_EU_URL = "https://app-api-eu.dreo-tech.com";
const CLIENT_ID = "89ef537b2202481aaaf9077068bcb0c9";
const CLIENT_SECRET = "41b20a1f60e9499e89c8646c31f93ea1";
const LEGACY_CLIENT_ID = "7de37c362ee54dcf9c4561812309347a";
const LEGACY_CLIENT_SECRET = "32dfa0764f25451d99f94e1693498791";
const USER_AGENT = "openapi/1.0.0";
const API_VERSION = "1.0.0";

const ENDPOINTS = {
  login: "/api/oauth/login",
  devices: "/api/v2/device/list",
  deviceState: "/api/v2/device/state",
  deviceControl: "/api/v2/device/control",
  legacyDevices: "/api/v2/user-device/device/list",
  legacyDeviceState: "/api/user-device/device/state",
};

export class DreoClient {
  private readonly email: string;
  private readonly password: string;
  private readonly logger: DreoLogger;
  private readonly debugMode: boolean;
  private readonly http: AxiosInstance;
  private readonly onLegacyMessage?: (message: Record<string, any>) => void | Promise<void>;

  private endpoint?: string;
  private accessToken?: string;
  private legacyEndpoint?: string;
  private legacyAccessToken?: string;
  private legacyRegion: "NA" | "EU" = "NA";
  private readonly legacyDeviceSerials = new Set<string>();
  private monitorWebSocket?: WebSocket;
  private monitorStopped = false;
  private monitorReconnectTimer?: NodeJS.Timeout;
  private monitorPingTimer?: NodeJS.Timeout;

  public constructor(options: DreoClientOptions) {
    this.email = options.email;
    this.password = options.password;
    this.logger = options.logger;
    this.debugMode = !!options.debugMode;
    this.onLegacyMessage = options.onLegacyMessage;
    this.http = axios.create({
      timeout: options.timeoutMs ?? 10_000,
      validateStatus: () => true,
    });
  }

  public get tokenInfo(): { endpoint?: string; region: "NA" | "EU"; hasToken: boolean } {
    return {
      endpoint: this.endpoint,
      region: this.extractTokenRegion(this.accessToken),
      hasToken: !!this.accessToken,
    };
  }

  public async login(): Promise<void> {
    if (!this.email || !this.password) {
      throw new DreoApiError("Dreo email and password are required", { authError: true });
    }

    const payload = await this.request<LoginResponse>({
      url: `${BASE_URL}${ENDPOINTS.login}`,
      method: "POST",
      params: this.baseParams(),
      data: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "openapi",
        scope: "all",
        email: this.email,
        password: this.preparePassword(this.password),
      },
      skipAuth: true,
    });

    this.accessToken = payload.access_token ?? payload.token;
    if (!this.accessToken) {
      throw new DreoApiError("Dreo login response did not contain an access token", { authError: true });
    }
    this.endpoint = payload.endpoint ?? this.resolveEndpoint(this.accessToken);
    this.debug(`Login successful. endpoint=${this.endpoint}, region=${this.extractTokenRegion(this.accessToken)}`);
  }

  public async getDevices(): Promise<DreoRawDevice[]> {
    await this.ensureAuthenticated();
    const payload = await this.requestWithReauth<any>({
      url: `${this.requireEndpoint()}${ENDPOINTS.devices}`,
      method: "GET",
      params: this.baseParams(),
    });

    const devices = this.extractDeviceItems(payload);
    if (devices.length) {
      this.debug(`Open API returned ${devices.length} devices`);
      return devices;
    }

    this.debugJson("Open API returned no devices; trying legacy app API. Payload", payload);
    const legacyDevices = await this.getLegacyDevices();
    for (const device of legacyDevices) {
      const serial = this.firstString(device, "deviceSn", "devicesn", "serialNumber", "serial_number", "sn");
      if (serial) this.legacyDeviceSerials.add(serial);
    }
    this.startLegacyMonitor();
    this.debug(`Legacy app API returned ${legacyDevices.length} devices`);
    return legacyDevices;
  }

  public stop(): void {
    this.monitorStopped = true;
    if (this.monitorReconnectTimer) clearTimeout(this.monitorReconnectTimer);
    if (this.monitorPingTimer) clearInterval(this.monitorPingTimer);
    this.monitorReconnectTimer = undefined;
    this.monitorPingTimer = undefined;
    if (this.monitorWebSocket) {
      try {
        this.monitorWebSocket.close();
      } catch {
        // Ignore close errors during adapter shutdown.
      }
    }
    this.monitorWebSocket = undefined;
  }

  public async getDeviceState(deviceSn: string): Promise<DreoRawState> {
    await this.ensureAuthenticated();
    if (this.legacyDeviceSerials.has(deviceSn)) {
      const state = await this.getLegacyDeviceState(deviceSn);
      if (Object.keys(state).length) return state;
      this.debug(`Legacy app API state for ${deviceSn} was empty; falling back to Open API state`);
    }

    try {
      const payload = await this.requestWithReauth<any>({
        url: `${this.requireEndpoint()}${ENDPOINTS.deviceState}`,
        method: "GET",
        params: { ...this.baseParams(), deviceSn },
      });
      const data = this.unwrapData(payload);
      if (this.isObject(data) && Object.keys(data).length) return data;
      this.debugJson(`Open API state for ${deviceSn} was empty; trying legacy app API. Payload`, payload);
    } catch (error) {
      this.logger.warn(`Open API state request failed for ${deviceSn}; trying legacy app API`);
      this.debugJson("Open API state error", this.errorToObject(error));
    }
    return await this.getLegacyDeviceState(deviceSn);
  }

  public async updateDeviceState(deviceSn: string, desired: Record<string, any>): Promise<Record<string, any>> {
    if (!Object.keys(desired).length) {
      throw new DreoApiError("Refusing to send an empty command payload");
    }

    await this.ensureAuthenticated();
    if (this.legacyDeviceSerials.has(deviceSn)) {
      await this.sendLegacyWebSocketCommand(deviceSn, desired);
      return { code: 0, data: { devicesn: deviceSn, desired, transport: "legacy-websocket" } };
    }

    return await this.requestWithReauth<Record<string, any>>({
      url: `${this.requireEndpoint()}${ENDPOINTS.deviceControl}`,
      method: "POST",
      params: this.baseParams(),
      data: {
        devicesn: deviceSn,
        desired,
      },
    });
  }

  private async requestWithReauth<T>(config: AxiosRequestConfig & { skipAuth?: boolean }): Promise<T> {
    await this.ensureAuthenticated();

    try {
      return await this.request<T>(config);
    } catch (error) {
      if (!(error instanceof DreoApiError) || !error.authError) throw error;
      this.logger.warn("Dreo token was rejected; refreshing session and retrying once");
      this.accessToken = undefined;
      this.endpoint = undefined;
      await this.login();
      return await this.request<T>(config);
    }
  }

  private async legacyLogin(region: "NA" | "EU" = this.legacyRegion): Promise<void> {
    const endpoint = region === "EU" ? LEGACY_EU_URL : LEGACY_URL;
    const payload = await this.request<LoginResponse>({
      url: `${endpoint}${ENDPOINTS.login}`,
      method: "POST",
      params: { timestamp: Date.now() },
      data: {
        acceptLanguage: "en",
        client_id: LEGACY_CLIENT_ID,
        client_secret: LEGACY_CLIENT_SECRET,
        email: this.email,
        encrypt: "ciphertext",
        grant_type: "email-password",
        himei: "faede31549d649f58864093158787ec9",
        password: this.preparePassword(this.password),
        scope: "all",
      },
      skipAuth: true,
      legacy: true,
    });

    if (payload.region && payload.region !== region) {
      const reportedRegion = payload.region.toUpperCase() === "EU" ? "EU" : "NA";
      this.debug(`Legacy login reported region ${reportedRegion}; retrying against matching app endpoint`);
      this.legacyRegion = reportedRegion;
      if (reportedRegion !== region) return await this.legacyLogin(reportedRegion);
    }

    this.legacyAccessToken = payload.access_token ?? payload.token;
    if (!this.legacyAccessToken) {
      throw new DreoApiError("Legacy Dreo login response did not contain an access token", { authError: true });
    }
    this.legacyEndpoint = endpoint;
  }

  private async getLegacyDevices(): Promise<DreoRawDevice[]> {
    await this.ensureLegacyAuthenticated();
    const payload = await this.legacyRequest<any>({
      url: `${this.requireLegacyEndpoint()}${ENDPOINTS.legacyDevices}`,
      method: "GET",
      params: {
        acceptLanguage: "en",
        method: "devices",
        pageNo: "1",
        pageSize: "100",
        timestamp: Date.now(),
      },
    });
    const devices = this.extractDeviceItems(payload);
    if (!devices.length) this.debugJson("Legacy app API returned no recognizable device list. Payload", payload);
    return devices;
  }

  private async getLegacyDeviceState(deviceSn: string): Promise<DreoRawState> {
    await this.ensureLegacyAuthenticated();
    const payload = await this.legacyRequest<any>({
      url: `${this.requireLegacyEndpoint()}${ENDPOINTS.legacyDeviceState}`,
      method: "GET",
      params: {
        acceptLanguage: "en",
        deviceSn,
        timestamp: Date.now(),
      },
    });
    const data = this.unwrapData(payload);
    if (this.isObject(data) && this.isObject(data.mixed)) return data.mixed;
    if (this.isObject(data) && this.isObject(data.reported)) return data.reported;
    if (this.isObject(data) && this.isObject(data.state)) return data.state;
    return this.isObject(data) ? data : {};
  }

  private async sendLegacyWebSocketCommand(deviceSn: string, desired: Record<string, any>): Promise<void> {
    await this.ensureLegacyAuthenticated();
    const region = this.legacyRegion === "EU" ? "eu" : "us";
    const url = `wss://wsb-${region}.dreo-tech.com/websocket?accessToken=${encodeURIComponent(this.requireLegacyAccessToken())}&timestamp=${Date.now()}`;
    const command = {
      devicesn: deviceSn,
      method: "control",
      params: desired,
      timestamp: String(Date.now()),
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.sendLegacyWebSocketCommandOnce(url, command, deviceSn);
        return;
      } catch (error) {
        if (attempt >= 2) throw error;
        this.logger.warn(`Dreo WebSocket command did not receive ACK; retrying (${attempt + 1}/2)`);
        await this.sleep(1_500 * (attempt + 1));
      }
    }
  }

  private async sendLegacyWebSocketCommandOnce(url: string, command: Record<string, any>, deviceSn: string): Promise<void> {
    this.debugJson("Sending legacy WebSocket command", { ...command, devicesn: deviceSn });
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      let pingTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        finish(new DreoApiError("Timed out waiting for Dreo WebSocket command ACK", { retryable: true }));
      }, 8_000);

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (pingTimer) clearInterval(pingTimer);
        try {
          ws.close();
        } catch {
          // Ignore close errors; the command outcome is already known.
        }
        if (error) reject(error);
        else resolve();
      };

      ws.on("open", () => {
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("2");
        }, 15_000);
        ws.send(JSON.stringify(command));
      });

      ws.on("message", (data) => {
        const raw = data.toString();
        if (raw === "2" || raw === "3") return;
        try {
          const message = JSON.parse(raw) as Record<string, any>;
          this.debugJson("Legacy WebSocket message", message);
          if (message.devicesn === deviceSn && message.method === "control-report") {
            finish();
          }
        } catch {
          this.debug(`Ignoring non-JSON Dreo WebSocket message: ${raw}`);
        }
      });

      ws.on("error", (error) => finish(new DreoApiError(`Dreo WebSocket command failed: ${error.message}`, { retryable: true })));
      ws.on("close", () => {
        if (!settled) finish(new DreoApiError("Dreo WebSocket closed before command ACK", { retryable: true }));
      });
    });
  }

  private startLegacyMonitor(): void {
    if (!this.onLegacyMessage || !this.legacyAccessToken || this.monitorStopped) return;
    if (this.monitorWebSocket && (this.monitorWebSocket.readyState === WebSocket.OPEN || this.monitorWebSocket.readyState === WebSocket.CONNECTING)) return;

    const region = this.legacyRegion === "EU" ? "eu" : "us";
    const url = `wss://wsb-${region}.dreo-tech.com/websocket?accessToken=${encodeURIComponent(this.requireLegacyAccessToken())}&timestamp=${Date.now()}`;
    this.debug(`Starting Dreo legacy WebSocket monitor for ${region}`);

    const ws = new WebSocket(url);
    this.monitorWebSocket = ws;

    ws.on("open", () => {
      this.debug("Dreo legacy WebSocket monitor connected");
      if (this.monitorPingTimer) clearInterval(this.monitorPingTimer);
      this.monitorPingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("2");
      }, 15_000);
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw === "2" || raw === "3") return;
      try {
        const message = JSON.parse(raw) as Record<string, any>;
        this.debugJson("Dreo legacy WebSocket monitor message", message);
        void Promise.resolve(this.onLegacyMessage?.(message)).catch((error) => {
          this.logger.warn(`Dreo WebSocket update callback failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch {
        this.debug(`Ignoring non-JSON Dreo monitor message: ${raw}`);
      }
    });

    ws.on("error", (error) => {
      this.logger.warn(`Dreo legacy WebSocket monitor error: ${error.message}`);
    });

    ws.on("close", () => {
      if (this.monitorPingTimer) clearInterval(this.monitorPingTimer);
      this.monitorPingTimer = undefined;
      this.monitorWebSocket = undefined;
      if (!this.monitorStopped) {
        this.logger.warn("Dreo legacy WebSocket monitor closed; reconnecting in 10 seconds");
        this.monitorReconnectTimer = setTimeout(() => this.startLegacyMonitor(), 10_000);
      }
    });
  }

  private async ensureLegacyAuthenticated(): Promise<void> {
    if (!this.legacyAccessToken || !this.legacyEndpoint) {
      await this.legacyLogin();
    }
  }

  private async legacyRequest<T>(config: AxiosRequestConfig): Promise<T> {
    await this.ensureLegacyAuthenticated();
    try {
      return await this.request<T>({
        ...config,
        legacy: true,
        legacyAuth: true,
      });
    } catch (error) {
      if (!(error instanceof DreoApiError) || !error.authError) throw error;
      this.logger.warn("Legacy Dreo token was rejected; refreshing session and retrying once");
      this.legacyAccessToken = undefined;
      this.legacyEndpoint = undefined;
      await this.legacyLogin();
      return await this.request<T>({
        ...config,
        legacy: true,
        legacyAuth: true,
      });
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.accessToken || !this.endpoint) {
      await this.login();
    }
  }

  private async request<T>(config: AxiosRequestConfig & { skipAuth?: boolean; legacy?: boolean; legacyAuth?: boolean }): Promise<T> {
    const headers: Record<string, string> = config.legacy
      ? {
          ua: "dreo/2.8.2",
          lang: "en",
          "content-type": "application/json; charset=UTF-8",
          "accept-encoding": "gzip",
          "user-agent": "okhttp/4.9.1",
        }
      : {
          "Content-Type": "application/json",
          UA: USER_AGENT,
        };
    if (config.legacyAuth) {
      headers.authorization = `Bearer ${this.requireLegacyAccessToken()}`;
    } else if (!config.skipAuth) {
      headers.Authorization = `Bearer ${this.stripTokenRegion(this.requireAccessToken())}`;
    }

    try {
      this.debug(`${config.method ?? "GET"} ${this.redactUrl(config.url ?? "")}`);
      const response = await this.http.request({
        ...config,
        headers: {
          ...headers,
          ...(config.headers ?? {}),
        },
      });

      if (response.status === 401 || response.status === 403) {
        throw new DreoApiError("Dreo authentication failed", { status: response.status, authError: true });
      }
      if (response.status === 429) {
        throw new DreoApiError("Dreo rate limit exceeded", { status: response.status, retryable: true });
      }
      if (response.status >= 500) {
        throw new DreoApiError(`Dreo server error: HTTP ${response.status}`, { status: response.status, retryable: true });
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DreoApiError(`Dreo request failed: HTTP ${response.status}`, { status: response.status });
      }

      const body = response.data;
      if (!this.isObject(body)) return body as T;
      if (body.code === 0 || body.code === "0" || body.code === undefined) {
        return this.unwrapData(body) as T;
      }
      throw new DreoApiError(String(body.msg ?? body.message ?? "Dreo business error"), {
        code: body.code,
        authError: body.code === 401 || body.code === 403,
      });
    } catch (error) {
      if (error instanceof DreoApiError) throw error;
      const axiosError = error as AxiosError;
      if (axiosError.code === "ECONNABORTED" || axiosError.code === "ETIMEDOUT") {
        throw new DreoApiError("Dreo request timed out", { retryable: true });
      }
      throw new DreoApiError(`Dreo request failed: ${axiosError.message ?? String(error)}`, { retryable: true });
    }
  }

  private extractDeviceItems(payload: any): DreoRawDevice[] {
    const data = this.unwrapData(payload);
    if (Array.isArray(data)) return data.filter(this.isObject);
    if (this.isObject(data)) {
      for (const key of ["devices", "deviceList", "list", "items", "records"]) {
        if (Array.isArray(data[key])) return data[key].filter(this.isObject);
      }
    }
    return [];
  }

  private firstString(payload: Record<string, any>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = payload[key];
      if (value !== undefined && value !== null && value !== "") return String(value);
    }
    return undefined;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private baseParams(): Record<string, any> {
    return {
      timestamp: Date.now(),
      dreover: API_VERSION,
    };
  }

  private preparePassword(password: string): string {
    return /^[0-9a-f]{32}$/i.test(password) ? password : crypto.createHash("md5").update(password, "utf8").digest("hex");
  }

  private resolveEndpoint(token?: string): string {
    return this.extractTokenRegion(token) === "EU" ? EU_BASE_URL : BASE_URL;
  }

  private extractTokenRegion(token?: string): "NA" | "EU" {
    if (!token || !token.includes(":")) return "NA";
    return token.split(":", 2)[1]?.toUpperCase() === "EU" ? "EU" : "NA";
  }

  private stripTokenRegion(token: string): string {
    return token.split(":", 1)[0];
  }

  private requireEndpoint(): string {
    if (!this.endpoint) throw new DreoApiError("Dreo endpoint is unavailable; login has not completed", { authError: true });
    return this.endpoint;
  }

  private requireAccessToken(): string {
    if (!this.accessToken) throw new DreoApiError("Dreo access token is unavailable; login has not completed", { authError: true });
    return this.accessToken;
  }

  private requireLegacyEndpoint(): string {
    if (!this.legacyEndpoint) throw new DreoApiError("Legacy Dreo endpoint is unavailable; login has not completed", { authError: true });
    return this.legacyEndpoint;
  }

  private requireLegacyAccessToken(): string {
    if (!this.legacyAccessToken) throw new DreoApiError("Legacy Dreo access token is unavailable; login has not completed", { authError: true });
    return this.legacyAccessToken;
  }

  private unwrapData(payload: any): any {
    return this.isObject(payload) && "data" in payload ? payload.data : payload;
  }

  private isObject(value: any): value is Record<string, any> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  private debug(message: string): void {
    if (this.debugMode) this.logger.debug(`[DreoClient] ${message}`);
  }

  private debugJson(message: string, value: any): void {
    if (this.debugMode) this.logger.debug(`[DreoClient] ${message}: ${JSON.stringify(value)}`);
  }

  private redactUrl(url: string): string {
    return url.replace(/accessToken=([^&]+)/i, "accessToken=<redacted>");
  }

  private errorToObject(error: unknown): Record<string, any> {
    if (error instanceof DreoApiError) {
      return {
        message: error.message,
        code: error.code,
        status: error.status,
        retryable: error.retryable,
        authError: error.authError,
      };
    }
    if (error instanceof Error) return { message: error.message };
    return { message: String(error) };
  }
}
