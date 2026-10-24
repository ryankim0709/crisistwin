/**
 * Reference places for orientation labels on the diorama. These are hand-entered
 * longitude/latitude pairs (WGS84, degrees) from public gazetteer values, rounded to ~100 m.
 * They are map furniture only: not model data, not fuel/terrain observations, and they never
 * influence the simulation. Only places inside the loaded board are drawn.
 * `rank` orders declutter priority (1 = shown first).
 */
export type ReferencePlace = { name: string; latitude: number; longitude: number; kind: "city" | "peak"; rank: 1 | 2 | 3 };

const city = (name: string, latitude: number, longitude: number, rank: 1 | 2 | 3): ReferencePlace => ({ name, latitude, longitude, kind: "city", rank });
const peak = (name: string, latitude: number, longitude: number, rank: 1 | 2 | 3): ReferencePlace => ({ name, latitude, longitude, kind: "peak", rank });

export const REFERENCE_PLACES: readonly ReferencePlace[] = [
  // San Francisco Bay Area
  city("San Francisco", 37.7749, -122.4194, 1),
  city("San Jose", 37.3382, -121.8863, 1),
  city("Oakland", 37.8044, -122.2712, 1),
  city("Berkeley", 37.8715, -122.273, 2),
  city("Richmond", 37.9358, -122.3478, 3),
  city("San Rafael", 37.9735, -122.5311, 2),
  city("Walnut Creek", 37.9101, -122.0652, 2),
  city("Hayward", 37.6688, -122.0808, 3),
  city("San Mateo", 37.563, -122.3255, 3),
  city("Fremont", 37.5485, -121.9886, 2),
  peak("Mt Diablo", 37.8816, -121.9142, 2),
  peak("Mt Tamalpais", 37.9235, -122.5965, 2),
  // Southern California
  city("Los Angeles", 34.0522, -118.2437, 1),
  city("San Diego", 32.7157, -117.1611, 1),
  city("Riverside", 33.9533, -117.3962, 1),
  city("San Bernardino", 34.1083, -117.2898, 1),
  city("Ventura", 34.2746, -119.229, 1),
  city("Irvine", 33.6846, -117.8265, 1),
  city("Palm Springs", 33.8303, -116.5453, 1),
  city("Pasadena", 34.1478, -118.1445, 2),
  city("Malibu", 34.0259, -118.7798, 2),
  city("Thousand Oaks", 34.1706, -118.8376, 2),
  city("Santa Clarita", 34.3917, -118.5426, 2),
  city("Escondido", 33.1192, -117.0864, 2),
  city("El Cajon", 32.7948, -116.9625, 2),
  city("Corona", 33.8753, -117.5664, 2),
  city("Hemet", 33.7475, -116.9719, 2),
  city("Ojai", 34.448, -119.2429, 2),
  city("Big Bear Lake", 34.2439, -116.9114, 2),
  city("Lake Arrowhead", 34.2481, -117.189, 2),
  city("Idyllwild", 33.7408, -116.715, 2),
  city("Mission Viejo", 33.6, -117.672, 3),
  city("Lake Elsinore", 33.6681, -117.3273, 3),
  city("Altadena", 34.1897, -118.1311, 3),
  city("San Fernando", 34.2819, -118.439, 3),
  city("Santa Paula", 34.3542, -119.0593, 3),
  city("Ramona", 33.0417, -116.8681, 3),
  city("Julian", 33.0786, -116.602, 3),
  city("Alpine", 32.835, -116.7664, 3),
  peak("Mt Baldy", 34.2889, -117.6464, 2),
  peak("Mt Wilson", 34.2244, -118.0572, 2),
  peak("San Gorgonio Mtn", 34.0993, -116.8242, 2),
  peak("San Jacinto Peak", 33.8147, -116.6797, 2),
  peak("Santiago Peak", 33.7109, -117.533, 2),
  peak("Cuyamaca Peak", 32.9872, -116.588, 2),
];
