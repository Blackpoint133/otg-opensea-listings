# Test evidence

The initial BR4 run failed four PostgreSQL tests because older fixtures represented provider/recovery states that no longer satisfied strict durable ProviderResult admission. Production validation was not weakened; fixtures were repaired to represent valid worker-reachable durable states. The complete suite then passed.
