/**
 * geocoder.js
 * Performs reverse geocoding to convert GPS coordinates to "City, State".
 * Uses the free BigDataCloud Reverse Geocode API.
 */

async function reverseGeocode(lat, lon) {
    if (lat == null || lon == null) return null;

    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;

    try {
        const res = await fetch(url);

        if (!res.ok) {
            console.error(`[Geocoder] API error ${res.status}`);
            return null;
        }

        const data = await res.json();
        
        // Extract city/locality and state
        const city = data.city || data.locality || null;
        const state = data.principalSubdivision || null;

        if (city && state) {
            // Some states in US have abbreviations, BigDataCloud returns full names.
            // Shorten common ones if needed, but full name is clearer.
            return `${city}, ${state}`;
        }
        if (state) return state;
        if (city) return city;
        
        return null;
    } catch (err) {
        console.error('[Geocoder] Error:', err.message);
        return null;
    }
}

module.exports = { reverseGeocode };
