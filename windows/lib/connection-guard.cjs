'use strict';
// One connection intent at a time across the independent engines. Disconnect
// invalidates any intent currently waiting for I/O or user confirmation.
class ConnectionGuard {
  constructor(){this.busy=false;this.generation=0;}
  run(task){
    if(this.busy)throw new Error('یک درخواست اتصال دیگر در حال انجام است.');
    const generation=++this.generation;this.busy=true;
    const check=()=>{if(generation!==this.generation)throw new Error('درخواست اتصال لغو شد.');};
    return (async()=>{try{check();return await task(check);}finally{this.busy=false;}})();
  }
  cancel(){++this.generation;}
}
module.exports={ConnectionGuard};
