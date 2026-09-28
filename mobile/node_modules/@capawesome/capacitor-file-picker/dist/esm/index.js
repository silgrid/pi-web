import { registerPlugin } from '@capacitor/core';
// See https://github.com/capawesome-team/capacitor-plugins/issues/14
import * as web from './web';
const FilePicker = registerPlugin('FilePicker', {
    web: () => new web.FilePickerWeb(),
});
export * from './definitions';
export { FilePicker };
//# sourceMappingURL=index.js.map