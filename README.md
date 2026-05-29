# ioBroker.dreo

Native ioBroker adapter for Dreo smart devices. The first supported device family is Dreo heaters / space heaters.

This adapter does **not** use Python, Home Assistant, or a subprocess bridge. The Dreo Cloud API logic was ported to TypeScript from the public Python projects `hass-dreo`, `pydreo-client`, and `hass-dreoverse`.

Dreo manufacturer website: https://www.dreo.com/

## Current Scope

- Login against Dreo Cloud with email/password
- MD5 password preparation as used by the Dreo Open API client
- Token region detection for US/EU API endpoints
- Device list retrieval
- Device state polling
- State writes mapped to Dreo Cloud control commands
- Retry/backoff for cloud and authentication errors
- Unknown devices remain visible with `info.rawData`
- No passwords or full access tokens are logged

## Dreo API Mapping

The current cloud implementation uses:

- Login: `POST https://open-api-us.dreo-tech.com/api/oauth/login`
- Devices: `GET /api/v2/device/list`
- State: `GET /api/v2/device/state?deviceSn=...`
- Control: `POST /api/v2/device/control`

Commands are sent as:

```json
{
  "devicesn": "DEVICE_SN",
  "desired": {
    "poweron": true
  }
}
```

Heater command keys ported from the Python projects:

- `poweron` for power
- `temperature` for current temperature
- `ecolevel` for target temperature
- `mode` for `coolair`, `hotair`, `eco`, `off`
- `htalevel` for heat level / exposed as `fanSpeed`
- `oscon`, `oscangle`, `oscmode` for oscillation variants
- `timeron`, `timeroff` for timer values

Where firmware behavior is unclear, the TypeScript code contains TODO comments and keeps debug/raw payloads available.

## ioBroker States

Devices are created under:

```text
dreo.0.devices.<deviceId>
```

Per device:

```text
info.name
info.model
info.deviceId
info.online
info.rawData
status.power
status.currentTemperature
status.targetTemperature
status.mode
status.fanSpeed
status.oscillation
status.timer
control.power
control.targetTemperature
control.mode
control.fanSpeed
control.oscillation
```

Unknown devices still get `info.*`, `status.power`, `control.power`, and complete `info.rawData`.

## Admin Config

- `email`: Dreo account email
- `password`: Dreo account password, stored via ioBroker encrypted native config
- `pollingInterval`: seconds between cloud polls, minimum 15
- `deviceFilter`: optional comma-separated device serial numbers, device IDs, names, or models
- `debugMode`: verbose adapter-side API/debug logging without secrets

## Setup

Create a Dreo adapter instance in ioBroker Admin, enter the Dreo credentials, choose the temperature unit, and start the instance.

## Test Anleitung

Build checks are executed by GitHub Actions for each push and pull request.

Expected results:

- `info.connection` becomes `true`
- device objects appear under `dreo.0.devices.*`
- `status.*` states update after each poll
- writing `control.power`, `control.targetTemperature`, `control.mode`, `control.fanSpeed`, or `control.oscillation` sends a cloud command and then refreshes state

## Debug Hints

Enable `debugMode` in the adapter config and set the instance log level to `debug`.

Useful checks:

```bash
iobroker logs dreo.0 --watch
iobroker object get dreo.0.devices.<id>.info.rawData
iobroker state get dreo.0.info.connection
```

If commands do not affect a device, inspect `info.rawData` and debug logs. Dreo firmware variants may expose oscillation as `oscon`, `oscangle`, or `oscmode`; the adapter chooses the visible property first and falls back to `oscon`.

## VIS Template

An importable VIS widget template is available in `vis/dreo-heater-widget.json`.
Replace `__DREO_DEVICE__` with your device object path, then import it in the VIS editor via **Widgets importieren**.

## Project Structure

```text
admin/jsonConfig.json
io-package.json
LICENSE
package.json
README.md
src/main.ts
src/lib/DreoClient.ts
src/lib/DreoDevice.ts
src/lib/DreoHeater.ts
tsconfig.json
vis/dreo-heater-widget.json
```

## Notes

Dreo does not provide a public official API. This adapter uses behavior discovered by community Python integrations and should be tested carefully with real devices.

## Changelog

### 0.0.10

- Prepared adapter metadata for official ioBroker repository submission.
- Added license, changelog, and GitHub Actions test workflow.
- Fixed temperature unit display encoding.

### 0.0.9

- Added importable VIS heater widget template.

### 0.0.8

- Improved Dreo state handling and Celsius/Fahrenheit conversion.

### 0.0.1

- Initial native TypeScript adapter for Dreo Cloud devices.

## License

MIT License. See [LICENSE](LICENSE) for details.
