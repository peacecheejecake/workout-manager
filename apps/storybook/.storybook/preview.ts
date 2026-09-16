import type { Preview } from '@storybook/react-vite';
import { storybookViewports } from '@workout/ui-foundation/responsive';
import '@workout/ui-foundation/tokens.css';
import '@workout/ui-foundation/responsive.css';
const preview: Preview = { parameters: { viewport: { options: storybookViewports } } };
export default preview;
