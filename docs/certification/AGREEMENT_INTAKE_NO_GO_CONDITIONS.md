# NO-GO conditions

Do not merge/pilot if any of these are true: migration fails or RLS can be bypassed; client can select tenant/workspace/actor authority; missing required terms can convert; extracted terms lose provenance; duplicate conversion creates duplicate canonical agreements; failed canonical creation marks intake converted; intake can activate/certify/release/pay; three paths create divergent Agreement semantics; production build/regression fails.
