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
export declare class DreoDevice {
    readonly info: NormalizedDreoDevice;
    protected readonly client: DreoClient;
    protected rawState: DreoRawState;
    protected properties: Record<string, any>;
    constructor(rawDevice: DreoRawDevice, client: DreoClient);
    static normalizeDevice(raw: DreoRawDevice): NormalizedDreoDevice;
    get isHeaterLike(): boolean;
    refresh(): Promise<void>;
    getRawState(): DreoRawState;
    getProperties(): Record<string, any>;
    applyReportedUpdate(reported: Record<string, any>): void;
    getOnline(): boolean | undefined;
    getCommonStates(): Record<string, DeviceStateValue>;
    supportsControl(control: string): boolean;
    setControl(control: string, value: any): Promise<Record<string, any>>;
    sendCommand(desired: Record<string, any>): Promise<Record<string, any>>;
    protected getStateValue(key: string): any;
    protected extractProperties(payload: DreoRawState): Record<string, any>;
    protected toBoolean(value: any): boolean;
    private safeRawPayload;
    private static firstString;
    private static extractOnline;
}
