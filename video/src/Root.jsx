import React from 'react';
import { Composition } from 'remotion';
import { Demo } from './Demo.jsx';
import { shots, timeline, fps } from './data.js';

export const Root = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={Math.round(timeline.totalSec * fps)}
    fps={fps}
    width={shots.width}
    height={shots.height}
  />
);
