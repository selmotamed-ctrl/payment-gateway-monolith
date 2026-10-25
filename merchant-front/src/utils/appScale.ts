/**
 * App Scale Utility
 *
 * Provides centralized control over the app's scale factor.
 * Uses CSS custom properties for smooth scaling without breaking layouts.
 */

export const appScale = ref(loadAppScale());


/**
 * Set the app scale factor
 * @param scale - Scale factor (0.5 to 1.5 recommended)
 */
export function setAppScale(scale: number): void {
    const root = document.documentElement;
    root.style.setProperty("--app-scale", scale.toString());
    appScale.value = scale;
}

/**
 * Get the current app scale factor
 * @returns Current scale factor
 */
export function loadAppScale(): number {
    const root = document.documentElement;
    const scale = root.style.getPropertyValue("--app-scale");
    return scale ? parseFloat(scale) : 0.9;
}

/**
 * Reset app scale to default
 */
export function resetAppScale(): void {
    setAppScale(0.9);
}

/**
 * Toggle between predefined scale levels
 */
export function toggleAppScale(): void {
    const currentScale = appScale.value;
    const scales = [0.8, 0.9, 1.0, 1.1];
    const currentIndex = scales.includes(currentScale) ? scales.indexOf(currentScale) : 0;
    const nextIndex = (currentIndex + 1) % scales.length;
    const nextScale = scales[nextIndex];
    if (nextScale !== undefined) {
        setAppScale(nextScale);
    }
}
