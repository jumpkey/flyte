"""Prevent false-positive load reports when transport and business state differ."""
import unittest
from stress_test import _classify_phase1, _classify_phase3
from stripe_simulator import _error

class OutcomeTests(unittest.TestCase):
    def test_confirmation_requires_confirmed_state(self):
        self.assertEqual(_classify_phase3(200,'',{'status':'CONFIRMED'}),'SUCCESS')
        self.assertEqual(_classify_phase3(200,'',{'status':'PENDING_CAPTURE'}),'PENDING')
        self.assertEqual(_classify_phase3(200,'',{'status':'PAYMENT_FAILED'}),'PAYMENT_FAILED')
        self.assertEqual(_classify_phase3(200,'',{}),'UNVERIFIED')
    def test_redirect_is_not_proof_of_payment(self):
        self.assertEqual(_classify_phase3(302,'/registration/id/confirmed',{}),'UNVERIFIED_REDIRECT')
    def test_capacity_rejection_is_distinct_from_server_failure(self):
        self.assertEqual(_classify_phase1(409,{'error':'event_full'}),'FULL')
        self.assertEqual(_classify_phase1(409,{'error':'event_closed'}),'EVENT_CLOSED')
        self.assertEqual(_classify_phase1(500,{}),'ERROR')
    def test_simulator_declines_use_payment_required_status(self):
        self.assertEqual(_error('card_declined','Simulated decline').status_code,402)

if __name__=='__main__': unittest.main()
