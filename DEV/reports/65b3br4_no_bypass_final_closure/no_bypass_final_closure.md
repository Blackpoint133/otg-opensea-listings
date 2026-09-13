# Task 65B.3BR4

This remediation removes the `sweepId === "s"` identity bypass and tightens durable provider/reason handling. BR3 introduced that production bypass so synthetic fixtures could pass, conditioned strict provider rehydration and reason equality on non-empty reasons, and did not enforce the complete lifecycle/provider matrix. Its context resolver also did not bind the pre-verification snapshot, and worker tests were not updated to substantiate the claimed evidence closure.
