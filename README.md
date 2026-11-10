# MMM-TideChartSVG

A [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) module that shows a tide chart
for one NOAA station, covering today and tomorrow (local time). High and low tides are labeled
with their time and height, and a marker shows the current time and tide level.

The chart is drawn as a lightweight SVG with no charting library, so it runs well on small
hardware such as a Raspberry Pi 3B+.

<!-- Screenshot to be added: screenshot.png -->

## Data

Tide predictions come from NOAA's [Tides & Currents](https://tidesandcurrents.noaa.gov/) API
(free, no key needed). Find your station's ID on the
[station map](https://tidesandcurrents.noaa.gov/map/index.html).

Data is fetched when MagicMirror starts and again at 00:01 local time each day. If a fetch
fails, the module keeps the last chart, shows "(latest update failed)", and retries every hour.

## Installation

```sh
cd ~/MagicMirror/modules
git clone <this repository's URL> MMM-TideChartSVG
```

No `npm install` is needed: the module has no dependencies.

## Configuration

Add the module to `config/config.js`:

```js
{
  module: "MMM-TideChartSVG",
  position: "top_right",
  config: {
    stationID: "9445958", // Bremerton, WA
    timezone: "America/Los_Angeles"
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `stationID` | *(required)* | NOAA tide station ID. |
| `timezone` | the mirror's timezone | IANA timezone name, e.g. `"America/Los_Angeles"`. Sets which two calendar days are shown and the times on the labels. |
| `units` | `"english"` | `"english"` (feet) or `"metric"` (meters). |
| `datum` | `"MLLW"` | NOAA height baseline ([datum options](https://tidesandcurrents.noaa.gov/datum_options.html)). MLLW (mean lower low water) is the usual baseline for tide charts. |
| `width` | `400` | Chart width in pixels. |
| `height` | `400` | Chart height in pixels. |
| `overlayUpdateInterval` | `60000` | How often the current-time marker moves, in milliseconds. |

## Limitations

- **One station per mirror.** Only the first instance's station is used. A second instance
  with a different station shows "Only one tide station per mirror is supported."
- Heights are NOAA's predictions only. They don't include weather effects such as storm surge.

## Development

Tests use Node's built-in test runner. From the module directory:

```sh
node --test
```

## License

MIT. See [LICENSE.md](LICENSE.md).
