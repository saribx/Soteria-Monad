import React from 'react';
import { IncidentCommandPanel } from '../command/IncidentCommandPanel';

// Bottom of the live map: decision, train damage and line status of the
// incident the operator is looking at.
export const BottomMetricsPanel: React.FC = () => <IncidentCommandPanel />;
