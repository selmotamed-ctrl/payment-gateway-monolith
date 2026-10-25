# App Scaling Feature

This Vue 3 TSX Vuetify application includes a comprehensive scaling system that allows you to scale the entire app to different sizes while maintaining layout integrity and functionality.

## How It Works

The scaling system uses CSS transform scale on the root `#app` element, which provides:
- Consistent scaling of all UI elements
- Preservation of layout relationships
- No interference with Vuetify's responsive system
- Smooth transitions between scale levels

## Default Scale

The app is set to scale to **0.9 (90%)** by default, making it slightly smaller than the viewport while maintaining full functionality.

## Control Methods

### 1. Account Actions Menu
- Click on your user profile in the top-right corner
- Select "App Scale" from the dropdown menu
- Choose from preset options: 80%, 90%, 100%, or "Toggle Scale"

### 2. Keyboard Shortcuts
- **Ctrl/Cmd + Plus** (`=`): Increase scale by 10%
- **Ctrl/Cmd + Minus** (`-`): Decrease scale by 10%
- **Ctrl/Cmd + 0**: Reset to default scale (90%)

### 3. Visual Indicator
- A scale indicator is displayed in the app bar showing the current scale percentage
- Click the indicator to quickly toggle between scale levels
- Hover for tooltip with keyboard shortcut hints

### 4. Programmatic Control

```typescript
import { setAppScale, getAppScale, toggleAppScale } from '@/utils/appScale';

// Set specific scale
setAppScale(0.8); // 80%
setAppScale(1.0); // 100%

// Get current scale
const currentScale = getAppScale();

// Toggle between preset scales
toggleAppScale();
```

## Technical Implementation

### CSS Variables
The scaling uses CSS custom properties for flexibility:

```scss
:root {
    --app-scale: 0.9;
}

#app {
    transform: scale(var(--app-scale));
    transform-origin: top left;
    width: calc(100% / var(--app-scale));
    height: calc(100% / var(--app-scale));
}
```

### Scale Range
- **Minimum**: 0.5 (50%)
- **Maximum**: 1.5 (150%)
- **Default**: 0.9 (90%)

## Benefits

1. **Consistent Scaling**: All elements scale proportionally
2. **Responsive Friendly**: Works with Vuetify's breakpoint system
3. **Performance**: Uses GPU-accelerated CSS transforms
4. **Accessibility**: Keyboard shortcuts for easy control
5. **User Control**: Multiple ways to adjust scale
6. **Non-Destructive**: Doesn't modify component logic or styles

## File Locations

- **Main Styles**: `src/styles/globals/app.scss`
- **Utility Functions**: `src/utils/appScale.ts`
- **UI Components**: `src/layouts/default.tsx`

## Troubleshooting

### Scale Not Applying
- Ensure the CSS is loaded correctly
- Check browser console for CSS errors
- Verify the `#app` element exists

### Layout Issues
- The scaling compensates for size changes automatically
- If issues occur, check for conflicting CSS transforms
- Ensure no fixed positioning conflicts

### Performance
- Scaling uses CSS transforms which are GPU-accelerated
- No JavaScript layout calculations required
- Smooth transitions between scale levels

## Future Enhancements

Potential improvements could include:
- Remember user's preferred scale in localStorage
- Add more granular scale controls
- Implement per-component scaling options
- Add animation presets for scale transitions
