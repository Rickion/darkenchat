// Nickname series for room theming
export const NICKNAME_SERIES: Record<string, string[]> = {
  nato:     ['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India','Juliet','Kilo','Lima','Mike','November','Oscar','Papa','Quebec','Romeo','Sierra','Tango','Uniform','Victor','Whiskey','Xray','Yankee','Zulu'],
  colors:   ['Amber','Cobalt','Crimson','Dusk','Frost','Ivory','Jade','Onyx','Ruby','Slate','Teal','Umber','Violet','Wisteria'],
  fruits:   ['Mango','Lychee','Papaya','Plum','Kiwi','Guava','Quince','Fig','Citrus','Durian','Lemon','Melon'],
  animals:  ['Lynx','Raven','Otter','Ibis','Finch','Crane','Vole','Dingo','Gecko','Heron','Kestrel','Merlin'],
  vehicles: ['Comet','Falcon','Zephyr','Nimbus','Arrow','Rocket','Glider','Osprey','Sprinter','Strider'],
  titles:   ['Marshal','Consul','Envoy','Regent','Legate','Warden','Herald','Prefect','Tribune','Sensei'],
}

export const SERIES_KEYS = Object.keys(NICKNAME_SERIES)

export function getRandomNickname(seriesKey: string, usedNames: string[] = []): string {
  const words = NICKNAME_SERIES[seriesKey] ?? NICKNAME_SERIES.nato
  const available = words.filter(w => !usedNames.includes(w))
  const pool = available.length > 0 ? available : words
  return pool[Math.floor(Math.random() * pool.length)]
}

export function getRandomSeriesKey(): string {
  return SERIES_KEYS[Math.floor(Math.random() * SERIES_KEYS.length)]
}
