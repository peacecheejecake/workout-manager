import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpikeWorkspace } from '@workout/ui-spike/workspace';

const meta = {
  title: 'Experiments/UI compatibility',
  component: SpikeWorkspace,
  args: { workerUrl: '/dist/maplibre/maplibre-gl-worker.mjs' },
} satisfies Meta<typeof SpikeWorkspace>;
export default meta;
export const Combined: StoryObj<typeof meta> = {};
