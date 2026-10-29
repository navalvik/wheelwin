/**
 * Process-wide dispatch budget for authenticated Toncenter Testnet reads.
 *
 * Every production ToncenterTransactionsClient shares one budget, including
 * the active Page4 observer, historical recovery and refund/payout verifiers.
 * Interactive Page4 requests overtake queued background recovery. Provider
 * HTTP 429 pauses ALL clients and temporarily lowers the read rate; it never
 * indicates payment failure or creates extra transaction requests.
 *
 * This is a read scheduler only: no wallet scans, transfers or polling.
 */
export class ToncenterReadBudget {
    constructor({
        requestsPerSecond = 6,
        reducedRequestsPerSecond = 2,
        defaultCooldownMs = 15_000,
        recoveryMs = 60_000,
        now = Date.now,
        schedule = (callback, ms) => setTimeout(callback, ms),
        cancel = id => clearTimeout(id)
    } = {}) {
        if (![requestsPerSecond,reducedRequestsPerSecond,defaultCooldownMs,recoveryMs]
            .every(n => Number.isSafeInteger(n) && n > 0)
            || reducedRequestsPerSecond > requestsPerSecond || requestsPerSecond > 10
            || typeof now !== "function" || typeof schedule !== "function"
            || typeof cancel !== "function")
            throw new TypeError("TONCENTER_READ_BUDGET_INVALID");
        Object.assign(this,{requestsPerSecond,reducedRequestsPerSecond,
            defaultCooldownMs,recoveryMs,now,schedule,cancel});
        this.high=[];
        this.low=[];
        this.dispatched=[];
        this.cooldownUntil=0;
        this.reducedUntil=0;
        this.timer=null;
    }
    acquire({priority="background"}={}) {
        if (priority !== "page4" && priority !== "background")
            return Promise.reject(new TypeError("TONCENTER_REQUEST_PRIORITY_INVALID"));
        if (this.high.length + this.low.length >= 1000)
            return Promise.reject(new Error("TONCENTER_READ_QUEUE_FULL"));
        return new Promise(resolve => {
            (priority === "page4" ? this.high : this.low).push(resolve);
            this._drain();
        });
    }
    /**
     * Retry-After is an upper-bounded suggestion, not permission to create
     * three more requests inside the same rate-limited time window.
     */
    noteRateLimited(retryAfterHeader = null) {
        const now=this.now();
        let ms=this.defaultCooldownMs;
        if (typeof retryAfterHeader === "string" && retryAfterHeader.trim()) {
            const seconds=Number(retryAfterHeader);
            if (Number.isFinite(seconds) && seconds >= 0)
                ms=Math.max(ms, seconds*1000);
            else {
                const date=Date.parse(retryAfterHeader);
                if (Number.isFinite(date)) ms=Math.max(ms,date-now);
            }
        }
        this.cooldownUntil=Math.max(this.cooldownUntil,now+Math.min(ms,60_000));
        this.reducedUntil=Math.max(this.reducedUntil,this.cooldownUntil+this.recoveryMs);
        this._drain(true);
    }
    _drain(forceReschedule=false) {
        if (forceReschedule && this.timer !== null) {
            this.cancel(this.timer); this.timer=null;
        }
        if (this.timer !== null) return;
        while(this.high.length || this.low.length) {
            const now=this.now();
            this.dispatched=this.dispatched.filter(t=>t>now-1000 && t<=now);
            const max=now<this.reducedUntil?this.reducedRequestsPerSecond:this.requestsPerSecond;
            const available=this.dispatched.length<max && now>=this.cooldownUntil;
            if (!available) {
                const nextSlot=this.dispatched.length>=max
                    ? this.dispatched[this.dispatched.length-max]+1000-now : 0;
                const wait=Math.max(1,this.cooldownUntil-now,nextSlot);
                this.timer=this.schedule(()=>{this.timer=null;this._drain();},wait);
                return;
            }
            const complete=(this.high.length?this.high:this.low).shift();
            this.dispatched.push(now);
            complete();
        }
    }
}

/** The only production dispatch budget for Toncenter v3 and masterchain reads. */
export const sharedToncenterReadBudget = new ToncenterReadBudget();
