import React from 'react';
import { FloatingAssetTooltip } from './FloatingAssetTooltip';

export const MapFloatingOverlay: React.FC<{ onOpenEdit?: () => void }> = ({ onOpenEdit }) => {

  return (
    <>

      {/* Floating Popover Tooltip for active vehicle */}
      <FloatingAssetTooltip onOpenEdit={onOpenEdit} />
    </>
  );
};
