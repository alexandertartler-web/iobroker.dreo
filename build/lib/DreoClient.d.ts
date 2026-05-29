export type DreoLogger = {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
};
export type DreoRawDevice = Record<string, any>;
export type DreoRawState = Record<string, any>;
export declare class DreoApiError extends Error {
    readonly code?: number | string;
    readonly status?: number;
    readonly retryable: boolean;
    readonly authError: boolean;
    constructor(message: string, options?: {
        code?: number | string;
        status?: number;
        retryable?: boolean;
        authError?: boolean;
    });
}
type DreoClientOptions = {
    email: string;
    password: string;
    logger: DreoLogger;
    debugMode?: boolean;
    timeoutMs?: number;
    onLegacyMessage?: (message: Record<string, any>) => void | Promise<void>;
};
export declare class DreoClient {
    private readonly email;
    private readonly password;
    private readonly logger;
    private readonly debugMode;
    private readonly http;
    private readonly onLegacyMessage?;
    private endpoint?;
    private accessToken?;
    private legacyEndpoint?;
    private legacyAccessToken?;
    private legacyRegion;
    private readonly legacyDeviceSerials;
    private monitorWebSocket?;
    private monitorStopped;
    private monitorReconnectTimer?;
    private monitorPingTimer?;
    constructor(options: DreoClientOptions);
    get tokenInfo(): {
        endpoint?: string;
        region: "NA" | "EU";
        hasToken: boolean;
    };
    login(): Promise<void>;
    getDevices(): Promise<DreoRawDevice[]>;
    stop(): void;
    getDeviceState(deviceSn: string): Promise<DreoRawState>;
    updateDeviceState(deviceSn: string, desired: Record<string, any>): Promise<Record<string, any>>;
    private requestWithReauth;
    private legacyLogin;
    private getLegacyDevices;
    private getLegacyDeviceState;
    private sendLegacyWebSocketCommand;
    private sendLegacyWebSocketCommandOnce;
    private startLegacyMonitor;
    private ensureLegacyAuthenticated;
    private legacyRequest;
    private ensureAuthenticated;
    private request;
    private extractDeviceItems;
    private firstString;
    private sleep;
    private baseParams;
    private preparePassword;
    private resolveEndpoint;
    private extractTokenRegion;
    private stripTokenRegion;
    private requireEndpoint;
    private requireAccessToken;
    private requireLegacyEndpoint;
    private requireLegacyAccessToken;
    private unwrapData;
    private isObject;
    private debug;
    private debugJson;
    private redactUrl;
    private errorToObject;
}
export {};
