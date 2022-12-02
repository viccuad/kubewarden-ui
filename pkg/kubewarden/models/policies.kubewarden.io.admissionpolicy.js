import { colorForState, stateBackground, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';
import { get } from '@shell/utils/object';

import KubewardenModel, { colorForStatus } from '../plugins/kubewarden/policy-class';

export default class AdmissionPolicy extends KubewardenModel {
  get stateDisplay() {
    const status = get(this, 'status.policyStatus');

    if ( status ) {
      return stateDisplay(status);
    }

    return stateDisplay();
  }

  get stateBackground() {
    const color = this.colorForState;

    if ( color ) {
      return color.replace('text-', 'bg-');
    }

    return stateBackground();
  }

  get colorForState() {
    const status = get(this, 'status.policyStatus');

    if ( status ) {
      return colorForStatus(status);
    }

    return colorForState(this.state);
  }
}
